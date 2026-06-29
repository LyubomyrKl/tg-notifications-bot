import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateNotificationInput,
  NotificationView,
  UpdateNotificationInput,
} from '@paedavic/contracts';
import { type Notification, PrismaService } from '@paedavic/database';
import { parsePlaceholders, renderTemplate } from './placeholder.util';

/**
 * Notification gallery — reusable templates. Every method takes `sourceId` and
 * scopes ALL queries by it, so a Source can only ever see/touch its own
 * templates (tenant isolation enforced here, not in the controller). Deletes are
 * soft (archive) only.
 */
@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    sourceId: string,
    input: CreateNotificationInput,
  ): Promise<NotificationView> {
    const created = await this.prisma.notification.create({
      data: {
        sourceId,
        name: input.name,
        body: input.body,
        mediaUrl: input.mediaUrl ?? null,
        mediaType: input.mediaType ?? null,
        placeholders: parsePlaceholders(input.body),
      },
    });
    return this.toView(created);
  }

  async list(
    sourceId: string,
    opts: { includeArchived?: boolean } = {},
  ): Promise<NotificationView[]> {
    const rows = await this.prisma.notification.findMany({
      where: {
        sourceId,
        ...(opts.includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toView(r));
  }

  async get(sourceId: string, id: string): Promise<NotificationView> {
    return this.toView(await this.findOwned(sourceId, id));
  }

  async update(
    sourceId: string,
    id: string,
    input: UpdateNotificationInput,
  ): Promise<NotificationView> {
    await this.findOwned(sourceId, id); // ownership check before mutate
    const updated = await this.prisma.notification.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.body !== undefined && {
          body: input.body,
          placeholders: parsePlaceholders(input.body),
        }),
        ...(input.mediaUrl !== undefined && { mediaUrl: input.mediaUrl }),
        ...(input.mediaType !== undefined && { mediaType: input.mediaType }),
      },
    });
    return this.toView(updated);
  }

  /** Clone a template into a new "(copy)" draft within the same workspace. */
  async duplicate(sourceId: string, id: string): Promise<NotificationView> {
    const src = await this.findOwned(sourceId, id);
    const copy = await this.prisma.notification.create({
      data: {
        sourceId,
        name: `${src.name} (copy)`,
        body: src.body,
        mediaUrl: src.mediaUrl,
        mediaType: src.mediaType,
        placeholders: src.placeholders,
      },
    });
    return this.toView(copy);
  }

  /** Soft-delete. The row stays for audit/history; it's excluded from lists. */
  async archive(sourceId: string, id: string): Promise<NotificationView> {
    await this.findOwned(sourceId, id);
    const archived = await this.prisma.notification.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
    return this.toView(archived);
  }

  /**
   * Render with placeholder values, rejecting any unfilled placeholder. This is
   * the shared check the broadcast slice reuses before queueing a send.
   */
  async preview(
    sourceId: string,
    id: string,
    values: Record<string, string>,
  ): Promise<{ text: string }> {
    const n = await this.findOwned(sourceId, id);
    return { text: renderTemplate(n.body, values) };
  }

  /** Tenant-scoped fetch — throws if the id isn't an active row in this Source. */
  private async findOwned(sourceId: string, id: string): Promise<Notification> {
    const n = await this.prisma.notification.findFirst({
      where: { id, sourceId, archivedAt: null },
    });
    if (!n) throw new NotFoundException('Notification not found');
    return n;
  }

  private toView(n: Notification): NotificationView {
    return {
      id: n.id,
      name: n.name,
      body: n.body,
      mediaUrl: n.mediaUrl,
      mediaType: n.mediaType,
      placeholders: n.placeholders,
      archivedAt: n.archivedAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
      updatedAt: n.updatedAt.toISOString(),
    };
  }
}
