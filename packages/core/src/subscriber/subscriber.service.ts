import { Injectable } from '@nestjs/common';
import type { SubscriberView } from '@paedavic/contracts';
import {
  PrismaService,
  type Subscriber,
  SubscriberStatus,
} from '@paedavic/database';

/**
 * Subscriber lifecycle. Identity is (sourceId, telegramUserId), so the same
 * person is a separate Subscriber per workspace — and every query is scoped by
 * sourceId. `upsert` is the idempotent entry point the invite-open and bot
 * flows (later slices) call when someone joins.
 */
@Injectable()
export class SubscriberService {
  constructor(private readonly prisma: PrismaService) {}

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
