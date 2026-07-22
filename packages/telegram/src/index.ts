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
// Re-export the inline-keyboard builder so consumers attach buttons without a
// direct grammY dependency (keeps core transport-agnostic).
export { InlineKeyboard } from 'grammy';
