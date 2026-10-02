import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { RepeatKind } from '@paedavic/contracts';
import {
  BroadcastStatus,
  PrismaService,
  ScheduledStatus,
  SubscriberStatus,
} from '@paedavic/database';
import { ScheduleQueue } from '@paedavic/queue';
import { BroadcastDeliveryService } from '../broadcast/broadcast-delivery.service';
import { BroadcastService } from '../broadcast/broadcast.service';
import { buildCronPattern } from '../schedule/schedule.service';

/** How long a broadcast may sit queued/sending before the sweep intervenes —
 *  long enough for a big fan-out to drain normally. */
const STUCK_GRACE_MS = 5 * 60_000;
/** Background sweep cadence (the boot sweep runs immediately). */
const SWEEP_INTERVAL_MS = 10 * 60_000;
/** Grace after `/stop` before a pendingDelete subscriber is actually erased.
 *  Generous, so an accidental /stop followed by a re-join loses nothing. */
const ERASURE_GRACE_MS = 30 * 24 * 3600_000; // 30 days

/**
 * Self-healing for the two queue/DB seams that can silently desync:
 *
 *  1. Scheduled rows vs Redis triggers. BullMQ state lives in Redis; if Redis
 *     loses it (container recreate, volume loss) every `scheduled` row still
 *     looks fine in the DB but nothing would ever fire. Re-registering is
 *     idempotent — deterministic job ids (`once-<id>`) and upsertJobScheduler
 *     dedupe against triggers that still exist — so every live row is simply
 *     re-registered on boot.
 *
 *  2. Broadcasts stuck `queued`/`sending`. A crash or Redis blip between the
 *     DB commit and enqueue (or between the last recipient finalize and the
 *     completion update) strands them with no jobs and no report. Re-enqueueing
 *     queued recipients is deduped by job id, and the completion re-check is a
 *     guarded transition — both safe to repeat.
 *
 * Runs wherever the consumers run (dedicated worker, or the API when
 * EMBED_WORKER is on). Concurrent sweeps from several processes are harmless —
 * every step is idempotent.
 */
@Injectable()
export class RecoveryService implements OnModuleDestroy {
  private readonly logger = new Logger(RecoveryService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduleQueue: ScheduleQueue,
    private readonly broadcasts: BroadcastService,
    private readonly delivery: BroadcastDeliveryService,
  ) {}

  /** Sweep now, then keep sweeping in the background. Idempotent. */
  start(): void {
    if (this.timer) return;
    void this.sweep().catch((err) =>
      this.logger.error(`boot recovery sweep failed: ${(err as Error).message}`),
    );
    this.timer = setInterval(
      () =>
        void this.sweep().catch((err) =>
          this.logger.error(`recovery sweep failed: ${(err as Error).message}`),
        ),
      SWEEP_INTERVAL_MS,
    );
    this.timer.unref(); // never keep the process alive just to sweep
  }

  /** One full pass. Exposed for tests. */
  async sweep(): Promise<void> {
    await this.reregisterSchedules();
    await this.requeueStuckBroadcasts();
    await this.erasePendingDeletes();
  }

  /** Make sure every live scheduled row has its Redis trigger. */
  private async reregisterSchedules(): Promise<void> {
    const rows = await this.prisma.scheduledBroadcast.findMany({
      where: { status: ScheduledStatus.scheduled },
      select: { id: true, sendAt: true, repeat: true },
    });
    for (const s of rows) {
      if (s.repeat === 'none') {
        await this.scheduleQueue.scheduleOnce(s.id, s.sendAt);
      } else {
        await this.scheduleQueue.scheduleRepeat(
          s.id,
          buildCronPattern(s.repeat as RepeatKind, s.sendAt),
          s.sendAt,
        );
      }
    }
    if (rows.length > 0) {
      this.logger.log(`ensured ${rows.length} schedule trigger(s) in Redis`);
    }
  }

  /** Unstick broadcasts whose jobs were lost, or whose completion never landed. */
  private async requeueStuckBroadcasts(): Promise<void> {
    const cutoff = new Date(Date.now() - STUCK_GRACE_MS);
    const stuck = await this.prisma.broadcast.findMany({
      where: {
        status: { in: [BroadcastStatus.queued, BroadcastStatus.sending] },
        createdAt: { lt: cutoff },
      },
      select: { id: true },
    });
    for (const b of stuck) {
      const requeued = await this.broadcasts.requeueStuckRecipients(b.id);
      if (requeued > 0) {
        this.logger.warn(
          `broadcast ${b.id}: re-enqueued ${requeued} stuck recipient(s)`,
        );
      } else {
        // Every recipient is terminal — only the completion update is missing.
        await this.delivery.completeIfDone(b.id);
      }
    }
  }

  /**
   * Honour the `/stop` erasure contract: subscribers flagged `pendingDelete`
   * whose unsubscribe is older than the grace period are hard-deleted (cascades
   * remove their group memberships, delivery rows, and responses — i.e. their
   * personal data). The grace window lets an accidental /stop be undone by a
   * re-join, which clears the flag.
   */
  private async erasePendingDeletes(): Promise<void> {
    const cutoff = new Date(Date.now() - ERASURE_GRACE_MS);
    const { count } = await this.prisma.subscriber.deleteMany({
      where: {
        pendingDelete: true,
        status: SubscriberStatus.unsubscribed,
        unsubscribedAt: { lt: cutoff },
      },
    });
    if (count > 0) {
      this.logger.log(`erased ${count} subscriber(s) past the deletion grace`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }
}
