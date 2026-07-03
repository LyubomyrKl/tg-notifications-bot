import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  RepeatKind,
  ScheduleBroadcastInput,
  ScheduledBroadcastView,
} from '@paedavic/contracts';
import {
  Prisma,
  PrismaService,
  type ScheduledBroadcast,
  ScheduledStatus,
} from '@paedavic/database';
import { ScheduleQueue } from '@paedavic/queue';
import { renderTemplate } from '../notification/placeholder.util';

/**
 * Schedule broadcasts for later (one-time) or on a cadence (daily/weekly). The
 * audience and placeholder render are deferred to fire time — this only records
 * intent and registers the trigger. All queries are sourceId-scoped.
 */
@Injectable()
export class ScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ScheduleQueue,
  ) {}

  async schedule(
    sourceId: string,
    input: ScheduleBroadcastInput,
    createdBy: string,
  ): Promise<ScheduledBroadcastView> {
    const notification = await this.prisma.notification.findFirst({
      where: { id: input.notificationId, sourceId, archivedAt: null },
    });
    if (!notification) throw new NotFoundException('Notification not found');
    // Fail fast if placeholders can't be satisfied — no surprise failure later.
    renderTemplate(notification.body, input.placeholderValues);

    const groupIds = [...new Set(input.groupIds)];
    const groups = await this.prisma.group.findMany({
      where: { id: { in: groupIds }, sourceId },
    });
    if (groups.length !== groupIds.length) {
      throw new NotFoundException('One or more target groups not found');
    }

    const sendAt = new Date(input.sendAt);
    if (Number.isNaN(sendAt.getTime())) {
      throw new BadRequestException('Invalid sendAt');
    }
    if (input.repeat === 'none' && sendAt.getTime() <= Date.now()) {
      throw new BadRequestException('sendAt must be in the future');
    }

    const created = await this.prisma.scheduledBroadcast.create({
      data: {
        sourceId,
        notificationId: notification.id,
        groupIds,
        placeholderValues: input.placeholderValues as Prisma.InputJsonValue,
        sendAt,
        repeat: input.repeat,
        createdBy,
      },
    });

    if (input.repeat === 'none') {
      await this.queue.scheduleOnce(created.id, sendAt);
    } else {
      await this.queue.scheduleRepeat(
        created.id,
        this.buildCron(input.repeat, sendAt),
        sendAt,
      );
    }
    return this.toView(created);
  }

  async list(sourceId: string): Promise<ScheduledBroadcastView[]> {
    const rows = await this.prisma.scheduledBroadcast.findMany({
      where: { sourceId },
      orderBy: { sendAt: 'asc' },
    });
    return rows.map((r) => this.toView(r));
  }

  async get(sourceId: string, id: string): Promise<ScheduledBroadcastView> {
    const row = await this.findOwned(sourceId, id);
    return this.toView(row);
  }

  async cancel(sourceId: string, id: string): Promise<ScheduledBroadcastView> {
    const row = await this.findOwned(sourceId, id);
    if (row.status !== ScheduledStatus.cancelled) {
      if (row.repeat === 'none') await this.queue.cancelOnce(row.id);
      else await this.queue.cancelRepeat(row.id);
      const updated = await this.prisma.scheduledBroadcast.update({
        where: { id },
        data: { status: ScheduledStatus.cancelled },
      });
      return this.toView(updated);
    }
    return this.toView(row);
  }

  /** Cron pattern (UTC) derived from the anchor time + cadence. */
  private buildCron(repeat: RepeatKind, at: Date): string {
    const m = at.getUTCMinutes();
    const h = at.getUTCHours();
    if (repeat === 'weekly') return `${m} ${h} * * ${at.getUTCDay()}`;
    return `${m} ${h} * * *`; // daily
  }

  private async findOwned(
    sourceId: string,
    id: string,
  ): Promise<ScheduledBroadcast> {
    const row = await this.prisma.scheduledBroadcast.findFirst({
      where: { id, sourceId },
    });
    if (!row) throw new NotFoundException('Scheduled broadcast not found');
    return row;
  }

  private toView(s: ScheduledBroadcast): ScheduledBroadcastView {
    return {
      id: s.id,
      notificationId: s.notificationId,
      groupIds: s.groupIds,
      sendAt: s.sendAt.toISOString(),
      repeat: s.repeat as RepeatKind,
      status: s.status,
      createdBy: s.createdBy,
      lastRunAt: s.lastRunAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
    };
  }
}
