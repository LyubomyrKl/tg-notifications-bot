import { Injectable, NotFoundException } from '@nestjs/common';
import type { SubscriberView } from '@paedavic/contracts';
import {
  PrismaService,
  type Subscriber,
  SubscriberStatus,
} from '@paedavic/database';
import { AuditAction, AuditService } from '../audit/audit.service';

/**
 * Subscriber lifecycle. Identity is (sourceId, telegramUserId), so the same
 * person is a separate Subscriber per workspace — and every query is scoped by
 * sourceId. `upsert` is the idempotent entry point the invite-open and bot
 * flows call when someone joins; `unsubscribe*` is the consent exit.
 */
@Injectable()
export class SubscriberService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Idempotently create-or-refresh a subscriber for a workspace. */
  async upsert(
    sourceId: string,
    telegramUserId: bigint,
    username?: string,
  ): Promise<Subscriber> {
    return this.prisma.subscriber.upsert({
      where: { sourceId_telegramUserId: { sourceId, telegramUserId } },
      create: { sourceId, telegramUserId, username: username ?? null },
      update: username !== undefined ? { username } : {},
    });
  }

  async list(
    sourceId: string,
    opts: { includeUnsubscribed?: boolean } = {},
  ): Promise<SubscriberView[]> {
    const rows = await this.prisma.subscriber.findMany({
      where: {
        sourceId,
        ...(opts.includeUnsubscribed
          ? {}
          : { status: SubscriberStatus.active }),
      },
      orderBy: { joinedAt: 'desc' },
    });
    return rows.map((s) => this.toView(s));
  }

  /**
   * Consent exit for the bot `/stop`: unsubscribe this Telegram user from EVERY
   * workspace they belong to, and flag for deletion. Active-only targeting then
   * excludes them everywhere. Returns the number of workspaces affected.
   */
  async unsubscribeByTelegramId(telegramUserId: bigint): Promise<number> {
    const active = await this.prisma.subscriber.findMany({
      where: { telegramUserId, status: SubscriberStatus.active },
      select: { id: true, sourceId: true },
    });
    for (const s of active) {
      await this.applyUnsubscribe(s.id, s.sourceId, 'telegram:/stop');
    }
    return active.length;
  }

  /** REST mirror of /stop: unsubscribe one subscriber within a workspace. */
  async unsubscribe(
    sourceId: string,
    subscriberId: string,
  ): Promise<SubscriberView> {
    const subscriber = await this.prisma.subscriber.findFirst({
      where: { id: subscriberId, sourceId },
    });
    if (!subscriber) throw new NotFoundException('Subscriber not found');
    if (subscriber.status === SubscriberStatus.unsubscribed) {
      return this.toView(subscriber); // idempotent
    }
    const updated = await this.applyUnsubscribe(
      subscriber.id,
      sourceId,
      `source:${sourceId}`,
    );
    return this.toView(updated);
  }

  /** Flip to unsubscribed + flag for deletion, and record the consent event. */
  private async applyUnsubscribe(
    subscriberId: string,
    sourceId: string,
    actor: string,
  ): Promise<Subscriber> {
    const updated = await this.prisma.subscriber.update({
      where: { id: subscriberId },
      data: {
        status: SubscriberStatus.unsubscribed,
        unsubscribedAt: new Date(),
        pendingDelete: true,
      },
    });
    await this.audit.record(
      sourceId,
      actor,
      AuditAction.SubscriberUnsubscribed,
      { subscriberId },
    );
    return updated;
  }

  toView(s: Subscriber): SubscriberView {
    return {
      id: s.id,
      telegramUserId: s.telegramUserId.toString(),
      username: s.username,
      status: s.status,
      joinedAt: s.joinedAt.toISOString(),
    };
  }
}
