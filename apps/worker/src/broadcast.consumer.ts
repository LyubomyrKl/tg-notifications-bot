import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { BroadcastDeliveryService } from '@paedavic/core';
import {
  BROADCAST_QUEUE,
  type BroadcastJobData,
  DELIVERY_ATTEMPTS,
  DELIVERY_LIMITER,
  createRedisConnection,
  deliveryBackoff,
} from '@paedavic/queue';
import { type Job, Worker } from 'bullmq';

/**
 * Thin BullMQ adapter: consume delivery jobs and hand each to the shared
 * BroadcastDeliveryService. Rate limiting (global throughput) and backoff
 * (per-job, 429-aware) are configured here; all delivery semantics live in the
 * service layer. When a job exhausts its retries, record the terminal failure.
 */
@Injectable()
export class BroadcastConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(BroadcastConsumer.name);
  private worker?: Worker<BroadcastJobData>;

  constructor(private readonly delivery: BroadcastDeliveryService) {}

  onApplicationBootstrap(): void {
    this.worker = new Worker<BroadcastJobData>(
      BROADCAST_QUEUE,
      async (job) =>
        this.delivery.processRecipient(job.data.broadcastId, job.data.recipientId),
      {
        connection: createRedisConnection(),
        concurrency: 10,
        limiter: DELIVERY_LIMITER,
        settings: {
          backoffStrategy: (attemptsMade: number, _type, err) =>
            deliveryBackoff(attemptsMade, err),
        },
      },
    );

    // Final failure (retries exhausted) → persist terminal status.
    this.worker.on('failed', (job, err) => {
      if (job && job.attemptsMade >= (job.opts.attempts ?? DELIVERY_ATTEMPTS)) {
        void this.delivery
          .markExhausted(job.data.broadcastId, job.data.recipientId, err.message)
          .catch((e) => this.logger.error(`markExhausted failed: ${e.message}`));
      } else {
        this.logger.warn(
          `job ${job?.id} attempt ${job?.attemptsMade} failed: ${err.message} (will retry)`,
        );
      }
    });

    this.logger.log(
      `Broadcast delivery worker listening on "${BROADCAST_QUEUE}"`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
