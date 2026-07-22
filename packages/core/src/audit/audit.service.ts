import { Injectable } from '@nestjs/common';
import type { AuditEntryView } from '@paedavic/contracts';
import { type AuditLog, Prisma, PrismaService } from '@paedavic/database';

/** Stable action verbs — keep these append-only so history stays readable. */
export const AuditAction = {
  BroadcastCreated: 'broadcast.created',
  SubscriberUnsubscribed: 'subscriber.unsubscribed',
  ResponseReceived: 'response.received',
} as const;

/**
 * Append-only audit trail. Records who did what, scoped to a Source. Failures to
 * write audit must never block the underlying action, so callers may fire-and-
 * forget; here we keep it simple and awaited (the actions are already in a tx
 * boundary upstream).
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    sourceId: string,
    actor: string,
    action: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        sourceId,
        actor,
        action,
        metadata: (metadata ?? undefined) as Prisma.InputJsonValue,
      },
    });
  }

  async list(sourceId: string, limit = 100): Promise<AuditEntryView[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { sourceId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => this.toView(r));
  }

  private toView(r: AuditLog): AuditEntryView {
    return {
      id: r.id,
      actor: r.actor,
      action: r.action,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
