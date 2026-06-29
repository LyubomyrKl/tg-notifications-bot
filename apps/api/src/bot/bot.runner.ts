import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { loadConfig } from '@paedavic/config';
import { SourceService } from '@paedavic/core';
import { type Context, TelegramService } from '@paedavic/telegram';

/**
 * The bot runtime (app-shaped): registers grammY command handlers and starts
 * long-polling. Handlers are THIN — they call the same SourceService the REST
 * controllers use. If no bot token is configured, the runtime stays dormant so
 * the API still boots (CI / API-only environments).
 */
@Injectable()
export class BotRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BotRunner.name);

  constructor(
    private readonly telegram: TelegramService,
    private readonly sources: SourceService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.telegram.enabled) {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN not set — bot runtime is dormant (API still serves REST).',
      );
      return;
    }
    this.registerHandlers();
    this.launch();
  }

  private registerHandlers(): void {
    const bot = this.telegram.bot;

    // /start <token> — provision-link a workspace, or generic welcome.
    bot.command('start', async (ctx) => {
      const token = ctx.match?.trim();
      if (!token) {
        await ctx.reply(
          'Welcome to Paedavic. Open a workspace start link to connect.',
        );
        return;
      }
      await this.handleStart(ctx, token);
    });

    bot.catch((err) => {
      this.logger.error(`Unhandled bot error: ${err.error}`);
    });
  }

  /** Idempotent: reopening a link re-confirms the existing binding. */
  private async handleStart(ctx: Context, token: string): Promise<void> {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) {
      await ctx.reply('Could not read your Telegram identity. Try again.');
      return;
    }

    try {
      const source = await this.sources.linkTelegram(
        token,
        BigInt(telegramUserId),
      );
      await ctx.reply(
        `✅ Connected to workspace "${source.name}". You can manage notifications from here.`,
      );
    } catch (err) {
      if (err instanceof NotFoundException) {
        await ctx.reply('⚠️ This start link is invalid or has expired.');
      } else if (err instanceof ConflictException) {
        await ctx.reply(`⚠️ ${err.message}`);
      } else {
        this.logger.error(`/start failed: ${(err as Error).message}`);
        await ctx.reply('Something went wrong. Please try again later.');
      }
    }
  }

  private launch(): void {
    const cfg = loadConfig();
    if (cfg.TELEGRAM_MODE === 'webhook') {
      // Slice 1 ships polling; webhook wiring is a later config switch (Hetzner).
      this.logger.warn(
        'TELEGRAM_MODE=webhook is not wired yet; falling back to polling.',
      );
    }
    // grammY long-polls in the background; do not await (resolves on stop).
    void this.telegram.bot.start({
      onStart: (info) =>
        this.logger.log(`Bot @${info.username} started (long-polling)`),
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.telegram.enabled && this.telegram.bot.isRunning()) {
      await this.telegram.bot.stop();
    }
  }
}
