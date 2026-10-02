import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  BroadcastDetail,
  BroadcastView,
  CreateBroadcastInput,
} from '@paedavic/contracts';
import {
  type Broadcast,
  BroadcastStatus,
  InteractionType,
  Prisma,
  PrismaService,
  RecipientStatus,
  SubscriberStatus,
} from '@paedavic/database';
import { BroadcastQueue } from '@paedavic/queue';
import { AuditAction, AuditService } from '../audit/audit.service';
import { resolveSendTargets } from './send-validation';

type BroadcastWithTargets = Broadcast & {
  targets: { groupId: string }[];
  _count?: { responses: number };
};

/** Every read includes targets (for groupIds) + a responses count (for views). */
const VIEW_INCLUDE = {
  targets: true,
  _count: { select: { responses: true } },
} as const;

/**
 * Broadcast orchestration. `create` is the one Source action; it validates the
 * template + placeholders + target groups (tenant-scoped), resolves the
 * recipient set AT SEND TIME (active subscribers only — consent), persists a
 * row-per-recipient, and enqueues delivery. The unique sendKey makes it
 * idempotent: a retried call returns the existing broadcast without re-sending.
 */
@Injectable()
export class BroadcastService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: BroadcastQueue,
    private readonly audit: AuditService,
  ) {}

  async create(
    sourceId: string,
    input: CreateBroadcastInput,
    createdBy: string,
  ): Promise<BroadcastView> {
    // Namespacing the sendKey per source makes the global unique = per-tenant.
    const scopedKey = `${sourceId}:${input.sendKey}`;

    // Idempotency: same key → return the existing broadcast instead of
    // re-sending. But first heal the half-created case: rows committed, then a
    // crash/Redis blip before enqueue left it stuck `queued` with no jobs — a
    // retry must re-enqueue the still-queued recipients. Job ids are
    // deterministic (recipientId), so when the jobs DO exist this dedupes to a
    // no-op rather than double-sending.
    const existing = await this.prisma.broadcast.findUnique({
      where: { sendKey: scopedKey },
      include: VIEW_INCLUDE,
    });
    if (existing) {
      if (
        existing.status === BroadcastStatus.queued ||
        existing.status === BroadcastStatus.sending
      ) {
        await this.requeueStuckRecipients(existing.id);
      }
      return this.toView(existing);
    }

    // Validate template + placeholders + target groups (tenant-scoped).
    const { notification, groups, groupIds } = await resolveSendTargets(
      this.prisma,
      sourceId,
      input,
    );

    // Resolve recipients NOW (active only): union of the targeted groups' members
    // and any directly-targeted subscribers, deduped.
    const recipientIds = await this.resolveRecipientIds(
      sourceId,
      groups,
      groupIds,
      input.subscriberIds,
    );
    const subscribers = recipientIds.map((id) => ({ id }));

    let broadcast: BroadcastWithTargets;
    try {
      broadcast = await this.prisma.broadcast.create({
        data: {
          sourceId,
          notificationId: notification.id,
          sendKey: scopedKey,
          placeholderValues: input.placeholderValues as Prisma.InputJsonValue,
          createdBy,
          interaction: input.interaction?.type ?? InteractionType.none,
          pollOptions: input.interaction?.options ?? [],
          totalCount: subscribers.length,
          status: subscribers.length
            ? BroadcastStatus.queued
            : BroadcastStatus.completed,
          completedAt: subscribers.length ? null : new Date(),
          targets: { create: groupIds.map((groupId) => ({ groupId })) },
          recipients: {
            create: subscribers.map((s) => ({ subscriberId: s.id })),
          },
        },
        include: VIEW_INCLUDE,
      });
    } catch (err) {
      // Lost a race on the unique sendKey → return the winner (still idempotent).
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const winner = await this.prisma.broadcast.findUnique({
          where: { sendKey: scopedKey },
          include: VIEW_INCLUDE,
        });
        if (winner) return this.toView(winner);
      }
      throw err;
    }

    // Enqueue one job per recipient (jobId dedupes on any retry).
    const recipients = await this.prisma.broadcastRecipient.findMany({
      where: { broadcastId: broadcast.id },
      select: { id: true },
    });
    await this.queue.enqueueRecipients(
      recipients.map((r) => ({ broadcastId: broadcast.id, recipientId: r.id })),
    );

    // Audit: who sent what, to which groups, and how many recipients.
    await this.audit.record(sourceId, createdBy, AuditAction.BroadcastCreated, {
      broadcastId: broadcast.id,
      notificationId: notification.id,
      groupIds,
      totalCount: subscribers.length,
    });

    return this.toView(broadcast);
  }

  /**
   * Re-enqueue delivery jobs for every still-queued recipient of a broadcast.
   * Safe to repeat: job ids are the recipient ids, so BullMQ dedupes against
   * jobs that already exist, and delivery itself skips non-queued recipients.
   * Used by the sendKey-retry heal above and the boot/interval recovery sweep.
   * Returns how many recipients were (re-)enqueued.
   */
  async requeueStuckRecipients(broadcastId: string): Promise<number> {
    const queued = await this.prisma.broadcastRecipient.findMany({
      where: { broadcastId, status: RecipientStatus.queued },
      select: { id: true },
    });
    if (queued.length > 0) {
      await this.queue.enqueueRecipients(
        queued.map((r) => ({ broadcastId, recipientId: r.id })),
      );
    }
    return queued.length;
  }

  async list(sourceId: string): Promise<BroadcastView[]> {
    const rows = await this.prisma.broadcast.findMany({
      where: { sourceId },
      include: VIEW_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((b) => this.toView(b));
  }

  async get(sourceId: string, id: string): Promise<BroadcastDetail> {
    const b = await this.prisma.broadcast.findFirst({
      where: { id, sourceId },
      include: { ...VIEW_INCLUDE, recipients: true },
    });
    if (!b) throw new NotFoundException('Broadcast not found');
    return {
      ...this.toView(b),
      recipients: b.recipients.map((r) => ({
        subscriberId: r.subscriberId,
        status: r.status,
        error: r.error,
        sentAt: r.sentAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * The deduped set of active subscriber ids to deliver to: everyone in the
   * targeted groups, plus any explicitly-targeted subscribers. Direct ids are
   * validated to belong to this Source (unknown id → 404); unsubscribed ones are
   * silently dropped (consent), so a 1:1 send to someone who left simply reaches
   * no one rather than erroring.
   */
  private async resolveRecipientIds(
    sourceId: string,
    groups: { isAll: boolean }[],
    groupIds: string[],
    subscriberIds: string[],
  ): Promise<string[]> {
    const ids = new Set<string>();

    if (groupIds.length > 0) {
      const includesAll = groups.some((g) => g.isAll);
      const rows = await this.prisma.subscriber.findMany({
        where: {
          sourceId,
          status: SubscriberStatus.active,
          ...(includesAll
            ? {}
            : { memberships: { some: { groupId: { in: groupIds } } } }),
        },
        select: { id: true },
      });
      rows.forEach((r) => ids.add(r.id));
    }

    const wanted = [...new Set(subscriberIds)];
    if (wanted.length > 0) {
      const owned = await this.prisma.subscriber.findMany({
        where: { sourceId, id: { in: wanted } },
        select: { id: true, status: true },
      });
      if (owned.length !== wanted.length) {
        throw new NotFoundException('One or more subscribers not found');
      }
      owned
        .filter((s) => s.status === SubscriberStatus.active)
        .forEach((s) => ids.add(s.id));
    }

    return [...ids];
  }

  private toView(b: BroadcastWithTargets): BroadcastView {
    return {
      id: b.id,
      notificationId: b.notificationId,
      status: b.status,
      groupIds: b.targets.map((t) => t.groupId),
      interaction: { type: b.interaction, options: b.pollOptions },
      responseCount: b._count?.responses ?? 0,
      createdBy: b.createdBy,
      totalCount: b.totalCount,
      sentCount: b.sentCount,
      failedCount: b.failedCount,
      blockedCount: b.blockedCount,
      createdAt: b.createdAt.toISOString(),
      completedAt: b.completedAt?.toISOString() ?? null,
    };
  }
}
