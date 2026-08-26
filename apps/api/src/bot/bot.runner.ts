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
import { type Context, profileName, TelegramService } from '@paedavic/telegram';
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

    // /start <token> — provision-link a workspace, or a role-aware welcome.
    bot.command('start', async (ctx) => {
      const token = ctx.match?.trim();
      if (!token) {
        await this.welcome(ctx);
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
   * Bare `/start` (no token). Role-aware so nobody sees the wrong thing:
   * owner → the admin menu; active subscriber → the reader card (no commands);
   * stranger → a connect prompt.
   */
  private async welcome(ctx: Context): Promise<void> {
    if (!ctx.from) {
      await ctx.reply('👋 Open a workspace invite or start link to get connected.');
      return;
    }
    const tgId = BigInt(ctx.from.id);
    // Opportunistic identity backfill: /start gives us fresh profile data for
    // subscribers who joined before names were captured. Fire-and-forget.
    void this.subscribers
      .refreshIdentity(tgId, ctx.from.username, profileName(ctx.from))
      .catch(() => undefined);
    if (await this.sources.resolveByTelegramId(tgId)) {
      await this.adminMenu.openHome(ctx, false);
      return;
    }
    const subs = await this.subscribers.activeSubscriptionsByTelegramId(tgId);
    if (subs.length) {
      await ctx.reply(this.adminMenu.consumerMessage(subs.map((s) => s.sourceName)), {
        parse_mode: 'HTML',
      });
      return;
    }
    await ctx.reply('👋 Open a workspace invite or start link to get connected.');
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
      // Reveal the admin command menu for this owner's chat (default scope is empty).
      await this.applyOwnerCommands(Number(telegramUserId));
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
      const result = await this.invites.open(token, telegramUserId, {
        username: ctx.from?.username,
        name: profileName(ctx.from),
      });
      const group = result.groupName ? ` and added to "${result.groupName}"` : '';
      const headline = result.alreadyJoined
        ? `👋 You're already subscribed to "${result.sourceName}".`
        : `🎉 Subscribed to "${result.sourceName}"${group}.`;
      await ctx.reply(
        `${headline}\n\nUpdates arrive right here — no commands needed. Tap the ` +
          'buttons on messages to respond, or send /stop anytime to leave.',
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
    // Command menu is role-scoped: the default scope is EMPTY (consumers see no
    // commands + no command button), and each linked owner gets the admin menu
    // scoped to their own chat. (Menu buttons are set inside applyCommandScopes.)
    void this.applyCommandScopes();

    // grammY long-polls in the background; do not await (resolves on stop).
    // Catch startup failures (e.g. a bad TELEGRAM_BOT_TOKEN → 401) so they log
    // an error instead of crashing the whole process (which would crash-loop the
    // container). The REST API stays up regardless.
    this.telegram.bot
      .start({
        onStart: (info) =>
          this.logger.log(`Bot @${info.username} started (long-polling)`),
      })
      .catch((err) =>
        this.logger.error(
          `Bot failed to start — check TELEGRAM_BOT_TOKEN. ${(err as Error).message}`,
        ),
      );
  }

  /**
   * The admin "/" menu — shown ONLY to owners (chat-scoped). The middle comes
   * from the menu's single source of truth so it can't drift from the handlers.
   */
  private ownerCommands(): { command: string; description: string }[] {
    return [
      { command: 'start', description: 'Open your workspace' },
      ...this.adminMenu.menuCommands(),
      { command: 'stop', description: 'Unsubscribe' },
    ];
  }

  /**
   * Default scope = no commands (consumers/strangers); every linked owner gets
   * the admin menu scoped to their chat. Run on boot so already-linked owners
   * keep their menu across restarts. Best-effort — never blocks startup.
   */
  private async applyCommandScopes(): Promise<void> {
    const api = this.telegram.bot.api;
    // Non-owners see NOTHING: clear the command list at both fall-through scopes
    // (default + all private chats), and reset the menu button to default so there's
    // no command affordance when the list is empty.
    await api.setMyCommands([], { scope: { type: 'default' } }).catch(() => undefined);
    await api
      .setMyCommands([], { scope: { type: 'all_private_chats' } })
      .catch(() => undefined);
    await api
      .setChatMenuButton({ menu_button: { type: 'default' } })
      .catch(() => undefined);
    // Owners get the admin menu scoped to their own chat (chat scope wins).
    const owners = await this.sources
      .listLinkedTelegramIds()
      .catch(() => [] as bigint[]);
    for (const id of owners) await this.applyOwnerCommands(Number(id));
    this.logger.log(
      `command scopes applied — default empty, ${owners.length} owner(s) scoped`,
    );
  }

  /** Give one owner's private chat the full admin command menu + command button. */
  private async applyOwnerCommands(chatId: number): Promise<void> {
    const api = this.telegram.bot.api;
    await api
      .setMyCommands(this.ownerCommands(), { scope: { type: 'chat', chat_id: chatId } })
      .catch(() => undefined);
    await api
      .setChatMenuButton({ chat_id: chatId, menu_button: { type: 'commands' } })
      .catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.telegram.enabled && this.telegram.bot.isRunning()) {
      await this.telegram.bot.stop();
    }
  }
}
