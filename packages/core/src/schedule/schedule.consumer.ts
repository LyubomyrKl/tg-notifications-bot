import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { PrismaService, ScheduledStatus } from '@paedavic/database';
import {
  SCHEDULE_QUEUE,
  type ScheduleJobData,
  ScheduleQueue,
  createRedisConnection,
} from '@paedavic/queue';
import { TelegramService } from '@paedavic/telegram';
import { type Job, UnrecoverableError, Worker } from 'bullmq';
import { BroadcastService } from '../broadcast/broadcast.service';
import { UnfilledPlaceholdersError } from '../notification/placeholder.util';

/** A one-time send more than this late is treated as stale — the moment passed
 *  (e.g. the server was down), so firing it now would surprise recipients.
 *  Skipped, and the owner is told so they can resend if they still want to. */
const STALE_ONE_TIME_MS = 60 * 60_000; // 1 hour

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
    private readonly queue: ScheduleQueue,
    private readonly telegram: TelegramService,
  ) {}

  start(): void {
    if (this.worker) return;
    this.worker = new Worker<ScheduleJobData>(
      SCHEDULE_QUEUE,
      (job) => this.fire(job),
      { connection: createRedisConnection(), concurrency: 5 },
    );
    // A terminal failure (unrecoverable, or retries spent) must not leave a row
    // stuck "scheduled" forever with nothing firing — mark it failed + tell the
    // owner. Best-effort; a transient failure just logs and retries.
    this.worker.on('failed', (job, err) => {
      const terminal =
        err instanceof UnrecoverableError ||
        err.name === 'UnrecoverableError' ||
        (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 1);
      if (job && terminal) {
        void this.markFailed(job.data.scheduledId, err.message).catch((e) =>
          this.logger.error(`markFailed ${job.data.scheduledId}: ${e.message}`),
        );
      } else {
        this.logger.warn(
          `schedule fire ${job?.id} failed: ${err.message} (will retry)`,
        );
      }
    });
    this.logger.log(`Schedule worker listening on "${SCHEDULE_QUEUE}"`);
  }

  private async fire(job: Job<ScheduleJobData>): Promise<string> {
    const s = await this.prisma.scheduledBroadcast.findUnique({
      where: { id: job.data.scheduledId },
    });
    // Only live schedules fire — covers cancelled, already-completed, and failed.
    if (!s || s.status !== ScheduledStatus.scheduled) return 'skipped';

    // Staleness: a one-time send whose moment passed while we were down should
    // NOT surprise recipients hours/days late. Skip it and tell the owner.
    if (
      s.repeat === 'none' &&
      Date.now() - s.sendAt.getTime() > STALE_ONE_TIME_MS
    ) {
      await this.prisma.scheduledBroadcast.update({
        where: { id: s.id },
        data: { status: ScheduledStatus.failed, lastRunAt: new Date() },
      });
      await this.notifyOwner(
        s.sourceId,
        '⏰ A scheduled message was skipped — its send time had already passed ' +
          '(the server may have been offline). Nothing was sent; resend it if you ' +
          'still need to.',
      );
      return 'stale';
    }

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
      try {
        await this.broadcasts.create(
          s.sourceId,
          {
            notificationId: s.notificationId,
            groupIds: groups.map((g) => g.id),
            subscriberIds: [],
            placeholderValues: s.placeholderValues as Record<string, string>,
            sendKey: `sched-${s.id}-${job.id}`,
          },
          s.createdBy,
        );
      } catch (err) {
        // Deterministic failures (template now has an unfilled placeholder, or a
        // referenced entity vanished) will fail identically on every retry —
        // make them terminal so the row ends up `failed`, not retried 3× then
        // stuck "scheduled".
        if (
          err instanceof UnfilledPlaceholdersError ||
          (err as { name?: string }).name === 'NotFoundException'
        ) {
          throw new UnrecoverableError((err as Error).message);
        }
        throw err; // transient → let BullMQ retry
      }
    } else {
      this.logger.warn(
        `scheduled ${s.id} fired with nothing to send (notif/groups gone)`,
      );
      await this.notifyOwner(
        s.sourceId,
        '⏰ A scheduled message had nothing to send — its template or target ' +
          'groups no longer exist.',
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

  /** Terminal failure: flag the row, stop any recurring trigger, tell the owner. */
  private async markFailed(scheduledId: string, reason: string): Promise<void> {
    const s = await this.prisma.scheduledBroadcast.findUnique({
      where: { id: scheduledId },
    });
    if (!s || s.status !== ScheduledStatus.scheduled) return;
    await this.prisma.scheduledBroadcast.update({
      where: { id: scheduledId },
      data: { status: ScheduledStatus.failed, lastRunAt: new Date() },
    });
    // A recurring schedule that fails deterministically would fail forever —
    // remove its trigger so it stops retrying every cycle.
    if (s.repeat !== 'none') {
      await this.queue.cancelRepeat(scheduledId).catch(() => undefined);
    }
    await this.notifyOwner(
      s.sourceId,
      `⏰ A scheduled message couldn't be sent and was stopped: ${reason}`,
    );
  }

  private async notifyOwner(sourceId: string, message: string): Promise<void> {
    if (!this.telegram.enabled) return;
    const source = await this.prisma.source.findUnique({
      where: { id: sourceId },
      select: { telegramUserId: true },
    });
    if (!source?.telegramUserId) return;
    await this.telegram
      .sendText(Number(source.telegramUserId), message)
      .catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
