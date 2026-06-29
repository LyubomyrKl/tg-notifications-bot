import { GrammyError, HttpError } from 'grammy';

/**
 * How a failed send should be treated by the delivery layer.
 * - rate_limited: Telegram 429 — retry after `retryAfter` seconds (backoff).
 * - blocked:      recipient blocked the bot / chat not found — terminal, no retry.
 * - failed:       transient or unknown — retryable up to the worker's attempt cap.
 */
export type SendErrorKind = 'rate_limited' | 'blocked' | 'failed';

export class TelegramSendError extends Error {
  constructor(
    readonly kind: SendErrorKind,
    message: string,
    /** Seconds to wait before retrying, when kind === 'rate_limited'. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'TelegramSendError';
  }
}

/** Telegram error codes that mean "this recipient is permanently undeliverable". */
const BLOCKED_DESCRIPTIONS = [
  'bot was blocked by the user',
  'user is deactivated',
  'chat not found',
  'bot can\'t initiate conversation',
  'have no rights to send a message',
];

/** Translate any thrown send error into a delivery-layer decision. */
export function classifySendError(err: unknown): TelegramSendError {
  if (err instanceof TelegramSendError) return err;

  if (err instanceof GrammyError) {
    if (err.error_code === 429) {
      const retryAfter = err.parameters?.retry_after ?? 1;
      return new TelegramSendError(
        'rate_limited',
        `Rate limited, retry after ${retryAfter}s`,
        retryAfter,
      );
    }
    const desc = err.description.toLowerCase();
    if (
      err.error_code === 403 ||
      BLOCKED_DESCRIPTIONS.some((d) => desc.includes(d))
    ) {
      return new TelegramSendError('blocked', err.description);
    }
    return new TelegramSendError('failed', err.description);
  }

  if (err instanceof HttpError) {
    return new TelegramSendError('failed', `Network error: ${err.message}`);
  }

  return new TelegramSendError(
    'failed',
    err instanceof Error ? err.message : 'Unknown send error',
  );
}
