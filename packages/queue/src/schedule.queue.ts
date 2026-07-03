import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  FIRE_JOB,
  SCHEDULE_QUEUE,
  type ScheduleJobData,
} from './constants';
import { createRedisConnection } from './connection';

/**
 * Producer for scheduled broadcasts. One-time sends use a delayed job; recurring
 * sends use a BullMQ job scheduler (cron). Both are keyed by the scheduled row's
 * id so they can be cancelled. State lives in Redis, so schedules survive
 * restarts without re-registration.
 */
@Injectable()
export class ScheduleQueue implements OnModuleDestroy {
  private readonly queue = new Queue<ScheduleJobData>(
    SCHEDULE_QUEUE,
    {
      connection: createRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'fixed', delay: 10_000 },
        removeOnComplete: 500,
        removeOnFail: 1000,
      },
    },
  );

  private onceJobId(id: string): string {
    return `once-${id}`;
  }

  /** Fire once at `runAt`. */
  async scheduleOnce(scheduledId: string, runAt: Date): Promise<void> {
    const delay = Math.max(0, runAt.getTime() - Date.now());
    await this.queue.add(
      FIRE_JOB,
      { scheduledId },
      { delay, jobId: this.onceJobId(scheduledId) },
    );
  }

  /** Fire on a cron `pattern` (UTC), starting no earlier than `startAt`. */
  async scheduleRepeat(
    scheduledId: string,
    pattern: string,
    startAt: Date,
  ): Promise<void> {
    await this.queue.upsertJobScheduler(
      scheduledId,
      { pattern, startDate: startAt },
      { name: FIRE_JOB, data: { scheduledId } },
    );
  }

  async cancelOnce(scheduledId: string): Promise<void> {
    await this.queue.remove(this.onceJobId(scheduledId)).catch(() => undefined);
  }

  async cancelRepeat(scheduledId: string): Promise<void> {
    await this.queue.removeJobScheduler(scheduledId).catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
