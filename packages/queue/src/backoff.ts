/**
 * Custom BullMQ backoff. When the failure carries a Telegram `retryAfter`
 * (a 429), honor it exactly; otherwise fall back to capped exponential. Wired
 * into the Worker via `settings.backoffStrategy` and selected per job with
 * `backoff: { type: 'custom' }`.
 */
export function deliveryBackoff(attemptsMade: number, err?: unknown): number {
  const retryAfter = (err as { retryAfter?: number } | undefined)?.retryAfter;
  if (typeof retryAfter === 'number' && retryAfter > 0) {
    return retryAfter * 1000;
  }
  // Exponential: 1s, 2s, 4s, 8s … capped at 60s.
  return Math.min(2 ** attemptsMade * 1000, 60_000);
}
