export { TelegramService } from './telegram.service';
export type { SendTextOptions } from './telegram.service';
export { TelegramModule } from './telegram.module';
export {
  TelegramSendError,
  classifySendError,
} from './send-error';
export type { SendErrorKind } from './send-error';

// Re-export grammY context type so app handlers type their middleware.
export type { Context } from 'grammy';

/**
 * A Telegram user's profile name ("First Last"), or undefined when absent.
 * The one place the first/last-name join convention lives.
 */
export function profileName(
  from?: { first_name?: string; last_name?: string },
): string | undefined {
  const name = [from?.first_name, from?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  return name || undefined;
}
// Re-export the inline-keyboard builder so consumers attach buttons without a
// direct grammY dependency (keeps core transport-agnostic).
export { InlineKeyboard } from 'grammy';
