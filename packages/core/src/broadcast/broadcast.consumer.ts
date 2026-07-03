import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  BROADCAST_QUEUE,
  type BroadcastJobData,
  DELIVERY_ATTEMPTS,
  DELIVERY_LIMITER,
  createRedisConnection,
  deliveryBackoff,
} from '@paedavic/queue';
import { Worker } from 'bullmq';
import { BroadcastDeliveryService } from './broadcast-delivery.service';

/**
 * BullMQ consumer for the delivery queue. Lives in core so it can run either in
 * a dedicated worker process OR embedded in the API process (single-process
 * mode) — the app decides by calling {@link start}. Rate limiting + 429-aware
 * backoff are configured here; all delivery semantics live in the service layer.
 */
@Injectable()
export class BroadcastConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(BroadcastConsumer.name);
  private worker?: Worker<BroadcastJobData>;

  constructor(private readonly delivery: BroadcastDeliveryService) {}

  /** Begin consuming the delivery queue. Idempotent — safe to call once. */
  start(): void {
    if (this.worker) return;
    this.worker = new Worker<BroadcastJobData>(
      BROADCAST_QUEUE,
      (job) =>
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

    this.logger.log(`Broadcast delivery worker listening on "${BROADCAST_QUEUE}"`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
