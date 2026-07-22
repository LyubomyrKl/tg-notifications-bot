import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { BroadcastResponses } from '@paedavic/contracts';
import {
  type Broadcast,
  InteractionType,
  PrismaService,
  type Subscriber,
  SubscriberStatus,
} from '@paedavic/database';
import { TelegramService } from '@paedavic/telegram';
import { AuditAction, AuditService } from '../audit/audit.service';

/**
 * Inbound side of two-way broadcasts: records a subscriber's poll vote or
 * free-text answer, notifies the workspace owner, and reads the collected
 * responses back for the owner's review screen / REST.
 *
 * Every write is tenant-derived from the broadcast (a subscriber may only
 * respond as an active member of that broadcast's Source) and idempotent per
 * (broadcast, subscriber) — a re-vote or re-answer overwrites the previous one.
 */
@Injectable()
export class ResponseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly telegram: TelegramService,
  ) {}

  /** Record (or change) a poll vote. Returns the chosen option's label. */
  async recordVote(
    broadcastId: string,
    telegramUserId: number | bigint,
    optionIndex: number,
  ): Promise<{ label: string }> {
    const broadcast = await this.loadInteractive(broadcastId, InteractionType.poll);
    if (optionIndex < 0 || optionIndex >= broadcast.pollOptions.length) {
      throw new BadRequestException('Unknown option');
    }
    const subscriber = await this.requireActiveSubscriber(
      broadcast.sourceId,
      telegramUserId,
    );

    await this.prisma.broadcastResponse.upsert({
      where: {
        broadcastId_subscriberId: { broadcastId, subscriberId: subscriber.id },
      },
      create: {
        sourceId: broadcast.sourceId,
        broadcastId,
        subscriberId: subscriber.id,
        optionIndex,
      },
      update: { optionIndex, text: null },
    });

    const label = broadcast.pollOptions[optionIndex];
    await this.afterResponse(broadcast, subscriber, `voted "${label}"`);
    return { label };
  }

  /** Record (or change) a free-text answer to a question broadcast. */
  async recordText(
    broadcastId: string,
    telegramUserId: number | bigint,
    text: string,
  ): Promise<void> {
    const broadcast = await this.loadInteractive(
      broadcastId,
      InteractionType.question,
    );
    const trimmed = text.trim();
    if (!trimmed) throw new BadRequestException('Empty answer');
    const subscriber = await this.requireActiveSubscriber(
      broadcast.sourceId,
      telegramUserId,
    );

    await this.prisma.broadcastResponse.upsert({
      where: {
        broadcastId_subscriberId: { broadcastId, subscriberId: subscriber.id },
      },
      create: {
        sourceId: broadcast.sourceId,
        broadcastId,
        subscriberId: subscriber.id,
        text: trimmed,
      },
      update: { text: trimmed, optionIndex: null },
    });

    const snippet = trimmed.length > 140 ? `${trimmed.slice(0, 137)}…` : trimmed;
    await this.afterResponse(broadcast, subscriber, `answered:\n${snippet}`);
  }

  /** All responses for a broadcast + (for polls) per-option tallies. Owner-scoped. */
  async list(sourceId: string, broadcastId: string): Promise<BroadcastResponses> {
    const broadcast = await this.prisma.broadcast.findFirst({
      where: { id: broadcastId, sourceId },
    });
    if (!broadcast) throw new NotFoundException('Broadcast not found');

    const rows = await this.prisma.broadcastResponse.findMany({
      where: { broadcastId },
      include: { subscriber: true },
      orderBy: { createdAt: 'desc' },
    });

    const tallies = broadcast.pollOptions.map((label, i) => ({
      optionIndex: i,
      label,
      count: rows.filter((r) => r.optionIndex === i).length,
    }));

    return {
      interaction: { type: broadcast.interaction, options: broadcast.pollOptions },
      responses: rows.map((r) => ({
        id: r.id,
        subscriberId: r.subscriberId,
        telegramUserId: r.subscriber.telegramUserId.toString(),
        username: r.subscriber.username,
        optionIndex: r.optionIndex,
        text: r.text,
        createdAt: r.createdAt.toISOString(),
      })),
      tallies,
    };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async loadInteractive(
    broadcastId: string,
    expected: InteractionType,
  ): Promise<Broadcast> {
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { id: broadcastId },
    });
    if (!broadcast || broadcast.interaction !== expected) {
      throw new BadRequestException('This message is no longer accepting responses');
    }
    return broadcast;
  }

  private async requireActiveSubscriber(
    sourceId: string,
    telegramUserId: number | bigint,
  ): Promise<Subscriber> {
    const subscriber = await this.prisma.subscriber.findUnique({
      where: {
        sourceId_telegramUserId: { sourceId, telegramUserId: BigInt(telegramUserId) },
      },
    });
    if (!subscriber || subscriber.status !== SubscriberStatus.active) {
      throw new ForbiddenException('You are not subscribed to this workspace');
    }
    return subscriber;
  }

  /** Audit + fire-and-forget owner ping after a response is stored. */
  private async afterResponse(
    broadcast: Broadcast,
    subscriber: Subscriber,
    what: string,
  ): Promise<void> {
    await this.audit.record(
      broadcast.sourceId,
      `telegram:${subscriber.telegramUserId}`,
      AuditAction.ResponseReceived,
      { broadcastId: broadcast.id, subscriberId: subscriber.id },
    );

    const notification = await this.prisma.notification.findUnique({
      where: { id: broadcast.notificationId },
      select: { name: true },
    });
    const who = subscriber.username
      ? `@${subscriber.username}`
      : `#${subscriber.telegramUserId}`;
    const on = notification ? ` on "${notification.name}"` : '';
    await this.pingOwner(broadcast.sourceId, `📥 ${who} ${what}${on}`);
  }

  private async pingOwner(sourceId: string, message: string): Promise<void> {
    if (!this.telegram.enabled) return;
    const source = await this.prisma.source.findUnique({
      where: { id: sourceId },
      select: { telegramUserId: true },
    });
    if (!source?.telegramUserId) return;
    // Plain text (no parse_mode) so subscriber-supplied content needs no escaping.
    await this.telegram
      .sendText(Number(source.telegramUserId), message)
      .catch(() => undefined);
  }
}
