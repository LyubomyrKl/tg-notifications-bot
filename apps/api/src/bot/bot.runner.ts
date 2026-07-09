import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { loadConfig } from '@paedavic/config';
import {
  InviteService,
  SourceService,
  SubscriberService,
} from '@paedavic/core';
import { type Context, TelegramService } from '@paedavic/telegram';
import { AdminMenu } from './admin-menu';

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
    private readonly invites: InviteService,
    private readonly subscribers: SubscriberService,
    private readonly adminMenu: AdminMenu,
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

    // Install the conversations engine FIRST so an active guided flow captures
    // the user's input ahead of the command/callback routes below.
    this.adminMenu.installConversations(bot);

    // /start <token> — provision-link a workspace, or generic welcome.
    bot.command('start', async (ctx) => {
      const token = ctx.match?.trim();
      if (!token) {
        // No payload: linked owners get the menu; everyone else, a welcome.
        const linked = ctx.from
          ? await this.sources.resolveByTelegramId(BigInt(ctx.from.id))
          : null;
        if (linked) await this.adminMenu.openHome(ctx, false);
        else await ctx.reply('Welcome to Paedavic. Open a workspace start link to connect.');
        return;
      }
      await this.handleStart(ctx, token);
    });

    // /stop — consent exit. Unsubscribe from every workspace + flag for deletion.
    bot.command('stop', async (ctx) => {
      if (!ctx.from) return;
      const count = await this.subscribers.unsubscribeByTelegramId(
        BigInt(ctx.from.id),
      );
      await ctx.reply(
        count > 0
          ? `🛑 Unsubscribed from ${count} workspace${count > 1 ? 's' : ''}. You won't receive further messages.`
          : "You weren't subscribed to anything.",
      );
    });

    // Button-driven admin UI (callbacks + /menu + free-text replies). Registered
    // after the command handlers so commands keep precedence over message:text.
    this.adminMenu.register(bot);

    bot.catch((err) => {
      this.logger.error(`Unhandled bot error: ${err.error}`);
    });
  }

  /**
   * Routes the /start payload: `inv_…` tokens are invite links (subscribe flow);
   * anything else is a workspace start token (owner-links their Telegram id).
   * Both paths are idempotent.
   */
  private async handleStart(ctx: Context, token: string): Promise<void> {
    const telegramUserId = ctx.from?.id;
    if (!telegramUserId) {
      await ctx.reply('Could not read your Telegram identity. Try again.');
      return;
    }
    if (InviteService.isInviteToken(token)) {
      await this.handleInvite(ctx, token, BigInt(telegramUserId));
    } else {
      await this.handleWorkspaceLink(ctx, token, BigInt(telegramUserId));
    }
  }

  /** Owner links their Telegram account to a workspace (idempotent). */
  private async handleWorkspaceLink(
    ctx: Context,
    token: string,
    telegramUserId: bigint,
  ): Promise<void> {
    try {
      const source = await this.sources.linkTelegram(token, telegramUserId);
      await ctx.reply(`✅ Connected to workspace "${source.name}".`);
      await this.adminMenu.openHome(ctx, false); // drop straight into the menu
      return;
    } catch (err) {
      if (err instanceof NotFoundException) {
        await ctx.reply('⚠️ This start link is invalid or has expired.');
      } else if (err instanceof ConflictException) {
        await ctx.reply(`⚠️ ${err.message}`);
      } else {
        this.logger.error(`/start link failed: ${(err as Error).message}`);
        await ctx.reply('Something went wrong. Please try again later.');
      }
    }
  }

  /** Subscriber joins via an invite link (idempotent). */
  private async handleInvite(
    ctx: Context,
    token: string,
    telegramUserId: bigint,
  ): Promise<void> {
    try {
      const result = await this.invites.open(
        token,
        telegramUserId,
        ctx.from?.username,
      );
      const group = result.groupName ? ` and added to "${result.groupName}"` : '';
      await ctx.reply(
        result.alreadyJoined
          ? `👋 You're already subscribed to "${result.sourceName}".`
          : `🎉 Subscribed to "${result.sourceName}"${group}.`,
      );
    } catch (err) {
      if (
        err instanceof NotFoundException ||
        err instanceof BadRequestException
      ) {
        await ctx.reply(`⚠️ ${(err as Error).message}`);
      } else {
        this.logger.error(`/start invite failed: ${(err as Error).message}`);
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
    // Show suggested commands in the Telegram UI (the "/" menu) + the menu button.
    // start/stop are owned here; the middle comes from the menu's single source
    // of truth so the "/" list can never drift from the registered handlers.
    void this.telegram.bot.api
      .setMyCommands([
        { command: 'start', description: 'Connect or open your workspace' },
        ...this.adminMenu.menuCommands(),
        { command: 'stop', description: 'Unsubscribe' },
      ])
      .catch(() => undefined);
    void this.telegram.bot.api
      .setChatMenuButton({ menu_button: { type: 'commands' } })
      .catch(() => undefined);

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
