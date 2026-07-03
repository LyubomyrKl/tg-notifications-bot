import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService, ScheduledStatus } from '@paedavic/database';
import {
  SCHEDULE_QUEUE,
  type ScheduleJobData,
  createRedisConnection,
} from '@paedavic/queue';
import { type Job, Worker } from 'bullmq';
import { BroadcastService } from '../broadcast/broadcast.service';

/**
 * Consumes schedule triggers. On fire, it resolves the CURRENT valid target
 * groups + creates a real broadcast (which resolves recipients live and queues
 * delivery). One-time schedules complete; recurring ones keep firing. Idempotent
 * via a per-fire sendKey so a retried trigger never double-sends.
 */
@Injectable()
export class ScheduleConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(ScheduleConsumer.name);
  private worker?: Worker<ScheduleJobData>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcasts: BroadcastService,
  ) {}

  start(): void {
    if (this.worker) return;
    this.worker = new Worker<ScheduleJobData>(
      SCHEDULE_QUEUE,
      (job) => this.fire(job),
      { connection: createRedisConnection(), concurrency: 5 },
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(`schedule fire ${job?.id} failed: ${err.message}`),
    );
    this.logger.log(`Schedule worker listening on "${SCHEDULE_QUEUE}"`);
  }

  private async fire(job: Job<ScheduleJobData>): Promise<string> {
    const s = await this.prisma.scheduledBroadcast.findUnique({
      where: { id: job.data.scheduledId },
    });
    if (!s || s.status === ScheduledStatus.cancelled) return 'skipped';

    // Notification may have been archived since scheduling.
    const notif = await this.prisma.notification.findFirst({
      where: { id: s.notificationId, sourceId: s.sourceId, archivedAt: null },
      select: { id: true },
    });
    // Groups may have been deleted; fire against whatever still exists.
    const groups = notif
      ? await this.prisma.group.findMany({
          where: { id: { in: s.groupIds }, sourceId: s.sourceId },
          select: { id: true },
        })
      : [];

    if (notif && groups.length) {
      await this.broadcasts.create(
        s.sourceId,
        {
          notificationId: s.notificationId,
          groupIds: groups.map((g) => g.id),
          placeholderValues: s.placeholderValues as Record<string, string>,
          sendKey: `sched-${s.id}-${job.id}`,
        },
        s.createdBy,
      );
    } else {
      this.logger.warn(
        `scheduled ${s.id} fired with nothing to send (notif/groups gone)`,
      );
    }

    await this.prisma.scheduledBroadcast.update({
      where: { id: s.id },
      data: {
        lastRunAt: new Date(),
        // One-time schedules are done after a single fire.
        ...(s.repeat === 'none' ? { status: ScheduledStatus.completed } : {}),
      },
    });
    return 'fired';
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
