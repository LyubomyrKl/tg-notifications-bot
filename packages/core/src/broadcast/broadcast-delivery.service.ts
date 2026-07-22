import { Injectable, Logger } from '@nestjs/common';
import {
  BroadcastStatus,
  PrismaService,
  RecipientStatus,
  SubscriberStatus,
} from '@paedavic/database';
import { TelegramSendError, TelegramService } from '@paedavic/telegram';
import { renderTemplate } from '../notification/placeholder.util';
import { buildInteractionKeyboard } from './interaction-keyboard';

export type DeliveryOutcome = 'sent' | 'blocked' | 'skipped' | 'unsubscribed';

/**
 * Per-recipient delivery — the worker's logic, kept in the service layer so the
 * worker app stays a thin BullMQ adapter. It is:
 *  - idempotent: re-running an already-terminal recipient is a no-op;
 *  - consent-aware: skips users who unsubscribed after the set was resolved;
 *  - retry-correct: RETHROWS on rate-limit/transient errors so BullMQ retries
 *    with backoff. Terminal failure is recorded by {@link markExhausted}, which
 *    the worker calls once BullMQ has spent all attempts.
 */
@Injectable()
export class BroadcastDeliveryService {
  private readonly logger = new Logger(BroadcastDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
  ) {}

  /** Process one recipient. Throws (→ BullMQ retry) on rate-limit/transient. */
  async processRecipient(
    broadcastId: string,
    recipientId: string,
  ): Promise<DeliveryOutcome> {
    const recipient = await this.prisma.broadcastRecipient.findUnique({
      where: { id: recipientId },
      include: { subscriber: true, broadcast: true },
    });
    if (!recipient || recipient.broadcastId !== broadcastId) return 'skipped';
    if (recipient.status !== RecipientStatus.queued) return 'skipped'; // already done

    // Consent: respect an unsubscribe that landed after recipient resolution.
    if (recipient.subscriber.status !== SubscriberStatus.active) {
      await this.finalize(recipientId, broadcastId, RecipientStatus.failed, {
        error: 'recipient unsubscribed before delivery',
      });
      return 'unsubscribed';
    }

    const notification = await this.prisma.notification.findUnique({
      where: { id: recipient.broadcast.notificationId },
    });
    if (!notification) {
      await this.finalize(recipientId, broadcastId, RecipientStatus.failed, {
        error: 'notification missing',
      });
      return 'skipped';
    }

    const text = renderTemplate(
      notification.body,
      recipient.broadcast.placeholderValues as Record<string, string>,
    );

    try {
      await this.telegram.sendText(
        Number(recipient.subscriber.telegramUserId),
        text,
        { keyboard: buildInteractionKeyboard(recipient.broadcast) },
      );
      await this.finalize(recipientId, broadcastId, RecipientStatus.sent, {
        sentAt: new Date(),
      });
      return 'sent';
    } catch (err) {
      const e =
        err instanceof TelegramSendError
          ? err
          : new TelegramSendError('failed', (err as Error).message);

      if (e.kind === 'blocked') {
        await this.finalize(recipientId, broadcastId, RecipientStatus.blocked, {
          error: e.message,
        });
        return 'blocked';
      }
      // rate_limited / failed → retry. Carries retryAfter for the backoff.
      throw e;
    }
  }

  /** Called by the worker after BullMQ exhausts retries. Idempotent. */
  async markExhausted(
    broadcastId: string,
    recipientId: string,
    error: string,
  ): Promise<void> {
    const recipient = await this.prisma.broadcastRecipient.findUnique({
      where: { id: recipientId },
    });
    if (!recipient || recipient.status !== RecipientStatus.queued) return;
    await this.finalize(recipientId, broadcastId, RecipientStatus.failed, {
      error,
    });
  }

  /**
   * Write a terminal recipient status, bump the matching aggregate counter, and
   * complete the broadcast once no recipient is still queued.
   */
  private async finalize(
    recipientId: string,
    broadcastId: string,
    status: RecipientStatus,
    extra: { error?: string; sentAt?: Date },
  ): Promise<void> {
    const counter =
      status === RecipientStatus.sent
        ? { sentCount: { increment: 1 } }
        : status === RecipientStatus.blocked
          ? { blockedCount: { increment: 1 } }
          : { failedCount: { increment: 1 } };

    await this.prisma.$transaction([
      this.prisma.broadcastRecipient.update({
        where: { id: recipientId },
        data: {
          status,
          error: extra.error ?? null,
          sentAt: extra.sentAt ?? null,
        },
      }),
      this.prisma.broadcast.update({
        where: { id: broadcastId },
        data: { ...counter, status: BroadcastStatus.sending },
      }),
    ]);

    const remaining = await this.prisma.broadcastRecipient.count({
      where: { broadcastId, status: RecipientStatus.queued },
    });
    if (remaining === 0) {
      await this.prisma.broadcast.update({
        where: { id: broadcastId },
        data: { status: BroadcastStatus.completed, completedAt: new Date() },
      });
      this.logger.log(`Broadcast ${broadcastId} completed`);
    }
  }
}
