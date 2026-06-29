import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  BROADCAST_QUEUE,
  type BroadcastJobData,
  DELIVER_JOB,
  type DeliverJobName,
  DELIVERY_ATTEMPTS,
} from './constants';
import { createRedisConnection } from './connection';

/**
 * Producer side of the delivery queue. The broadcast service calls
 * `enqueueRecipients` after persisting recipient rows. Each job gets a
 * deterministic id (`broadcastId:recipientId`) so re-enqueueing on a retried
 * create is deduped by BullMQ — double-send protection at the queue layer, on
 * top of the unique sendKey at the DB layer.
 */
@Injectable()
export class BroadcastQueue implements OnModuleDestroy {
  private readonly queue = new Queue<BroadcastJobData, void, DeliverJobName>(
    BROADCAST_QUEUE,
    {
      connection: createRedisConnection(),
      defaultJobOptions: {
        attempts: DELIVERY_ATTEMPTS,
        backoff: { type: 'custom' },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    },
  );

  async enqueueRecipients(jobs: BroadcastJobData[]): Promise<void> {
    if (jobs.length === 0) return;
    await this.queue.addBulk(
      jobs.map((data) => ({
        name: DELIVER_JOB,
        data,
        // BullMQ forbids ':' in custom job ids; recipientId is globally unique.
        opts: { jobId: data.recipientId },
      })),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
