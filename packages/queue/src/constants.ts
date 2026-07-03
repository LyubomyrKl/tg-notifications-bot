/** Shared queue contract between the producer (core/api) and consumer (worker). */
export const BROADCAST_QUEUE = 'broadcast-delivery';

/** The single job name on the delivery queue. */
export const DELIVER_JOB = 'deliver';
export type DeliverJobName = typeof DELIVER_JOB;

/**
 * One job = one recipient. The payload is intentionally minimal (just ids); the
 * worker loads the broadcast/notification/recipient and renders at send time, so
 * jobs stay small and always reflect current data.
 */
export interface BroadcastJobData {
  broadcastId: string;
  recipientId: string;
}

/** Per-recipient delivery tuning. attempts covers transient + rate-limit retries. */
export const DELIVERY_ATTEMPTS = 5;

// ── Scheduling ──────────────────────────────────────────────────────────────
/** Queue of "fire this scheduled broadcast now" triggers (delayed / recurring). */
export const SCHEDULE_QUEUE = 'broadcast-schedule';
export const FIRE_JOB = 'fire';
export type FireJobName = typeof FIRE_JOB;

/** One trigger carries only the scheduled-broadcast id; config is loaded on fire. */
export interface ScheduleJobData {
  scheduledId: string;
}

/**
 * Throughput cap for the worker — stay comfortably under Telegram's ~30 msg/s
 * global limit. (Per-chat limits are handled by 429 backoff, not this.)
 */
export const DELIVERY_LIMITER = { max: 25, duration: 1000 };
