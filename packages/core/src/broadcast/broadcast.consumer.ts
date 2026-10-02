import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  BROADCAST_QUEUE,
  type BroadcastJobData,
  DELIVERY_ATTEMPTS,
  DELIVERY_LIMITER,
  createRedisConnection,
  deliveryBackoff,
} from '@paedavic/queue';
import { UnrecoverableError, Worker } from 'bullmq';
import { BroadcastDeliveryService } from './broadcast-delivery.service';

/**
 * True when BullMQ will NOT retry a failed delivery job: either the attempts
 * are spent, or the failure is unrecoverable. The latter is also how BullMQ
 * reports a stall-exhausted job (crashed/stuck worker twice) — those arrive
 * with attemptsMade still low, so an attempts-only check misreads them as
 * "will retry" and the recipient stays queued, wedging the broadcast in
 * `sending` with no delivery report, forever.
 */
export function isTerminalDeliveryFailure(
  job: { attemptsMade: number; opts: { attempts?: number } },
  err: Error,
): boolean {
  return (
    job.attemptsMade >= (job.opts.attempts ?? DELIVERY_ATTEMPTS) ||
    err instanceof UnrecoverableError ||
    err.name === 'UnrecoverableError'
  );
}

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

    // Final failure (retries exhausted OR unrecoverable) → persist terminal
    // status so the broadcast can complete and the owner gets their report.
    this.worker.on('failed', (job, err) => {
      if (job && isTerminalDeliveryFailure(job, err)) {
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
