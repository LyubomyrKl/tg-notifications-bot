import { Injectable, Logger } from '@nestjs/common';
import {
  BroadcastStatus,
  PrismaService,
  RecipientStatus,
  SubscriberStatus,
} from '@paedavic/database';
import { TelegramSendError, TelegramService } from '@paedavic/telegram';
import { renderTemplate } from '../notification/placeholder.util';
import { subscriberDisplayName } from '../subscriber/subscriber.service';
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
      if (e.terminal) {
        // Deterministic failure (e.g. message too long) — retrying is futile, so
        // record it now instead of burning the whole attempt budget per recipient.
        await this.finalize(recipientId, broadcastId, RecipientStatus.failed, {
          error: e.message,
        });
        return 'skipped';
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

    // Guarded flip: only a recipient still `queued` transitions, and its counter
    // bumps IN THE SAME TRANSACTION. A duplicated/stalled re-run finds the row
    // already terminal (count === 0) and does nothing — so counters can't
    // double-count (no more "Delivered to 2 of 1").
    const applied = await this.prisma.$transaction(async (tx) => {
      const res = await tx.broadcastRecipient.updateMany({
        where: { id: recipientId, status: RecipientStatus.queued },
        data: {
          status,
          error: extra.error ?? null,
          sentAt: extra.sentAt ?? null,
        },
      });
      if (res.count === 0) return false;
      await tx.broadcast.update({
        where: { id: broadcastId },
        data: { ...counter, status: BroadcastStatus.sending },
      });
      return true;
    });
    if (!applied) return; // already finalized by another run — don't re-complete

    await this.completeIfDone(broadcastId);
  }

  /**
   * Complete the broadcast once no recipient is still queued, and send the
   * owner their delivery report. Guarded transition: when two recipients
   * finalize concurrently (or the recovery sweep re-runs this after a crash
   * between the last finalize and completion), exactly one caller wins — so
   * the owner gets ONE report.
   */
  async completeIfDone(broadcastId: string): Promise<void> {
    const remaining = await this.prisma.broadcastRecipient.count({
      where: { broadcastId, status: RecipientStatus.queued },
    });
    if (remaining > 0) return;
    const done = await this.prisma.broadcast.updateMany({
      where: { id: broadcastId, status: { not: BroadcastStatus.completed } },
      data: { status: BroadcastStatus.completed, completedAt: new Date() },
    });
    if (done.count > 0) {
      this.logger.log(`Broadcast ${broadcastId} completed`);
      await this.reportDelivery(broadcastId).catch((err) =>
        this.logger.warn(
          `Delivery report for ${broadcastId} failed: ${(err as Error).message}`,
        ),
      );
    }
  }

  /**
   * One message to the owner when a broadcast completes: a single ✅ line when
   * everyone got it, otherwise exactly who missed out and why. Plain text (no
   * parse_mode) so subscriber names need no escaping. Best-effort — a failed
   * report never fails the delivery job.
   */
  private async reportDelivery(broadcastId: string): Promise<void> {
    if (!this.telegram.enabled) return;
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { id: broadcastId },
      include: {
        notification: { select: { name: true } },
        source: { select: { telegramUserId: true } },
      },
    });
    if (!broadcast?.source?.telegramUserId || broadcast.totalCount === 0) return;

    const recipients = await this.prisma.broadcastRecipient.findMany({
      where: { broadcastId },
      include: { subscriber: true },
    });

    const name = broadcast.notification?.name ?? 'message';
    const { sentCount: delivered, totalCount: total } = broadcast;

    // Audience label: targeted group names (snapshotted at send time, so this
    // holds even if a group was later deleted); otherwise the directly-picked
    // people by name. Capped so the report stays skimmable.
    const audienceNames = broadcast.groupNames.length
      ? broadcast.groupNames
      : recipients.map((r) => subscriberDisplayName(r.subscriber));
    const shownNames = audienceNames.slice(0, 3).join(', ');
    const audience =
      (audienceNames.length > 3
        ? `${shownNames} +${audienceNames.length - 3} more`
        : shownNames) || `${total} recipient${total === 1 ? '' : 's'}`;

    let text: string;
    if (delivered === total && total === 1) {
      text = `📬 "${name}" delivered to ${audience} ✅`;
    } else if (delivered === total) {
      text = `📬 "${name}" → ${audience}\nDelivered to all ${total} ✅`;
    } else {
      const missed = recipients.filter((r) => r.status !== RecipientStatus.sent);
      const shown = missed.slice(0, 10);
      const lines = shown.map(
        (r) => `• ${subscriberDisplayName(r.subscriber)} — ${missReason(r)}`,
      );
      const more = missed.length - shown.length;
      text =
        `📬 "${name}" → ${audience}\n` +
        `Delivered to ${delivered} of ${total}\n` +
        'Not delivered:\n' +
        lines.join('\n') +
        (more > 0 ? `\n…and ${more} more` : '');
    }
    await this.telegram.sendText(Number(broadcast.source.telegramUserId), text);
  }
}

/** Human reason a recipient missed the send, from their terminal status. */
function missReason(r: { status: RecipientStatus; error: string | null }): string {
  if (r.status === RecipientStatus.blocked) return 'blocked the bot';
  if (r.error?.includes('unsubscribed')) return 'unsubscribed';
  return 'delivery failed';
}
