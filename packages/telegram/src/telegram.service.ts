import {Injectable, OnModuleDestroy,} from '@nestjs/common';
import {loadConfig} from '@paedavic/config';
import {Bot} from 'grammy';
import {classifySendError, TelegramSendError} from './send-error';

export interface SendTextOptions {
  parseMode?: 'HTML' | 'MarkdownV2';
}

/**
 * The shared Telegram client capability — imported by BOTH the api app (which
 * registers command handlers on `bot` and starts the runtime) and the worker
 * app (which only sends). It owns the grammY Bot instance and a send wrapper
 * that classifies failures (429 / blocked / transient) for the delivery layer.
 *
 * It does NOT register handlers or decide the run mode — that's the app's job,
 * keeping this package transport-policy-free.
 */
@Injectable()
export class TelegramService implements OnModuleDestroy {
  private readonly _bot: Bot | null;
  readonly username: string;

  constructor() {
    const cfg = loadConfig();
    this.username = cfg.TELEGRAM_BOT_USERNAME;
    this._bot = cfg.TELEGRAM_BOT_TOKEN
      ? new Bot(cfg.TELEGRAM_BOT_TOKEN)
      : null;
  }

  /** True when a bot token is configured and the client is usable. */
  get enabled(): boolean {
    return this._bot !== null;
  }

  /** The grammY Bot. Throws if no token is configured — guard with `enabled`. */
  get bot(): Bot {
    if (!this._bot) {
      throw new Error(
        'Telegram bot is not configured (TELEGRAM_BOT_TOKEN is empty).',
      );
    }
    return this._bot;
  }

  /** Build the public deep-link for a workspace's start token. */
  buildStartLink(startToken: string): string {
    const bot = this.username || '<bot>';
    return `https://t.me/${bot}?start=${startToken}`;
  }

  /**
   * Send a text message. On failure throws a {@link TelegramSendError} carrying
   * the delivery decision (rate_limited + retryAfter, blocked, or failed).
   * Callers (the broadcast worker) map that onto recipient status + backoff.
   */
  async sendText(
    chatId: string | number,
    text: string,
    opts: SendTextOptions = {},
  ): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, text, {
        parse_mode: opts.parseMode,
      });
    } catch (err) {
        throw classifySendError(err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this._bot && this._bot.isRunning()) {
      await this._bot.stop();
    }
  }
}
