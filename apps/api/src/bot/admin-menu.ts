import { Injectable, Logger } from '@nestjs/common';
import {
  type AuthPrincipal,
  BroadcastService,
  GroupService,
  InviteService,
  NotificationService,
  SourceService,
  SubscriberService,
} from '@paedavic/core';
import { type Bot, type Context, InlineKeyboard } from 'grammy';
import { clearSession, getSession } from './session';

/**
 * Button-driven admin UI inside Telegram — no slash commands needed. The
 * workspace owner taps through notifications, groups, invite links, and
 * broadcasts; every handler is thin and calls the shared service layer.
 *
 * Navigation edits the same message in place (smooth, no chat spam). The few
 * actions that genuinely need free text (naming a group, filling placeholders)
 * use a short-lived session and a single reply prompt.
 */
@Injectable()
export class AdminMenu {
  private readonly logger = new Logger(AdminMenu.name);

  constructor(
    private readonly sources: SourceService,
    private readonly notifications: NotificationService,
    private readonly groups: GroupService,
    private readonly invites: InviteService,
    private readonly broadcasts: BroadcastService,
    private readonly subscribers: SubscriberService,
  ) {}

  /** Wire the menu onto the bot. Call after command handlers are registered. */
  register(bot: Bot): void {
    bot.command('menu', (ctx) => this.openHome(ctx, false));
    bot.on('callback_query:data', (ctx) => this.onCallback(ctx));
    bot.on('message:text', (ctx) => this.onText(ctx));
  }

  /** Show the main menu — `home` keyboard the owner returns to. */
  async openHome(ctx: Context, edit: boolean): Promise<void> {
    const principal = await this.requireOwner(ctx);
    if (!principal) return;
    const kb = new InlineKeyboard()
      .text('📝 Notifications', 'notif:list')
      .text('👥 Groups', 'grp:list')
      .row()
      .text('🔗 Invite links', 'inv:list')
      .text('📣 Broadcast', 'bc:start');
    await this.render(ctx, 'What would you like to do?', kb, edit);
  }

  // ── Callback router ────────────────────────────────────────────────────────

  private async onCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? '';
    await ctx.answerCallbackQuery().catch(() => undefined); // ack the spinner
    const principal = await this.requireOwner(ctx);
    if (!principal) return;

    try {
      const [ns, action, ...rest] = data.split(':');
      const arg = rest.join(':'); // e.g. "groupId:subscriberId" for toggles
      if (ns === 'menu') return void (await this.openHome(ctx, true));
      if (ns === 'notif') return void (await this.notif(ctx, principal, action, arg));
      if (ns === 'grp') return void (await this.grp(ctx, principal, action, arg));
      if (ns === 'inv') return void (await this.inv(ctx, principal, action, arg));
      if (ns === 'bc') return void (await this.bc(ctx, principal, action, arg));
    } catch (err) {
      this.logger.error(`menu action "${data}" failed: ${(err as Error).message}`);
      await ctx.answerCallbackQuery({
        text: `⚠️ ${(err as Error).message}`.slice(0, 190),
        show_alert: true,
      }).catch(() => undefined);
    }
  }

  // ── Notifications ──────────────────────────────────────────────────────────

  private async notif(
    ctx: Context,
    p: AuthPrincipal,
    action: string,
    id: string,
  ): Promise<void> {
    if (action === 'list') {
      const items = await this.notifications.list(p.sourceId);
      const kb = new InlineKeyboard();
      items.forEach((n) => kb.text(`📝 ${n.name}`, `notif:view:${n.id}`).row());
      kb.text('➕ New notification', 'notif:new').row();
      kb.text('⬅️ Menu', 'menu:home');
      await this.render(
        ctx,
        items.length ? '📝 Your notifications:' : 'No notifications yet.',
        kb,
        true,
      );
      return;
    }
    if (action === 'new') {
      const s = getSession(ctx.from!.id);
      s.notifDraft = {};
      s.awaiting = 'notif_name';
      await ctx.reply('✏️ Send me a name for the notification:');
      return;
    }
    if (action === 'view') {
      const n = await this.notifications.get(p.sourceId, id);
      const ph = n.placeholders.length ? n.placeholders.join(', ') : 'none';
      const kb = new InlineKeyboard()
        .text('📋 Duplicate', `notif:dup:${id}`)
        .text('🗑 Archive', `notif:arch:${id}`)
        .row()
        .text('⬅️ Back', 'notif:list');
      await this.render(ctx, `📝 ${n.name}\n\n${n.body}\n\nPlaceholders: ${ph}`, kb, true);
      return;
    }
    if (action === 'dup') {
      await this.notifications.duplicate(p.sourceId, id);
      await this.notif(ctx, p, 'list', '');
    }
    if (action === 'arch') {
      await this.notifications.archive(p.sourceId, id);
      await this.notif(ctx, p, 'list', '');
    }
  }

  // ── Groups ─────────────────────────────────────────────────────────────────

  private async grp(
    ctx: Context,
    p: AuthPrincipal,
    action: string,
    id: string,
  ): Promise<void> {
    if (action === 'list') {
      const items = await this.groups.list(p.sourceId);
      const kb = new InlineKeyboard();
      items.forEach((g) =>
        kb.text(`👥 ${g.name} (${g.memberCount})`, `grp:view:${g.id}`).row(),
      );
      kb.text('➕ New group', 'grp:new').text('⬅️ Menu', 'menu:home');
      await this.render(ctx, '👥 Your groups:', kb, true);
      return;
    }
    if (action === 'view') {
      const g = (await this.groups.list(p.sourceId)).find((x) => x.id === id);
      if (!g) return this.grp(ctx, p, 'list', '');
      const kb = new InlineKeyboard();
      // The "All" group's membership is implicit (everyone) — not editable.
      if (!g.isAll) {
        kb.text('👤 Manage members', `grp:mem:${id}`).row();
        kb.text('🗑 Delete', `grp:del:${id}`);
      }
      kb.text('⬅️ Back', 'grp:list');
      await this.render(ctx, `👥 ${g.name}\nMembers: ${g.memberCount}`, kb, true);
      return;
    }
    if (action === 'mem') {
      // Toggle UI: every active subscriber with a ✅/⬜ marker for membership.
      await this.renderMembers(ctx, p, id);
      return;
    }
    if (action === 'tog') {
      const [groupId, subscriberId] = id.split(':');
      const memberIds = await this.memberIdSet(p, groupId);
      if (memberIds.has(subscriberId)) {
        await this.groups.removeMember(p.sourceId, groupId, subscriberId);
      } else {
        await this.groups.addMembers(p.sourceId, groupId, [subscriberId]);
      }
      await this.renderMembers(ctx, p, groupId);
      return;
    }
    if (action === 'del') {
      await this.groups.delete(p.sourceId, id);
      await this.grp(ctx, p, 'list', '');
    }
    if (action === 'new') {
      getSession(ctx.from!.id).awaiting = 'group_name';
      await ctx.reply('✏️ Send me the new group name:');
    }
  }

  /** Current members of a group, as a set of subscriber ids. */
  private async memberIdSet(
    p: AuthPrincipal,
    groupId: string,
  ): Promise<Set<string>> {
    const members = await this.groups.members(p.sourceId, groupId);
    return new Set(members.map((m) => m.id));
  }

  /** Render the tap-to-toggle membership list for a group. */
  private async renderMembers(
    ctx: Context,
    p: AuthPrincipal,
    groupId: string,
  ): Promise<void> {
    const [all, memberIds] = await Promise.all([
      this.subscribers.list(p.sourceId),
      this.memberIdSet(p, groupId),
    ]);
    const kb = new InlineKeyboard();
    all.forEach((s) => {
      const label = s.username ? `@${s.username}` : s.telegramUserId;
      kb.text(
        `${memberIds.has(s.id) ? '✅' : '⬜'} ${label}`,
        `grp:tog:${groupId}:${s.id}`,
      ).row();
    });
    kb.text('⬅️ Back', `grp:view:${groupId}`);
    await this.render(
      ctx,
      all.length
        ? 'Tap a subscriber to add/remove them from this group:'
        : 'No subscribers yet — share an invite link first.',
      kb,
      true,
    );
  }

  // ── Invite links ───────────────────────────────────────────────────────────

  private async inv(
    ctx: Context,
    p: AuthPrincipal,
    action: string,
    id: string,
  ): Promise<void> {
    if (action === 'list') {
      const items = await this.invites.list(p.sourceId);
      const kb = new InlineKeyboard();
      items.forEach((l) =>
        kb
          .text(
            `🔗 ${l.joinCount} joins${l.active ? '' : ' (revoked)'}`,
            `inv:view:${l.id}`,
          )
          .row(),
      );
      kb.text('➕ New link', 'inv:new').text('⬅️ Menu', 'menu:home');
      await this.render(
        ctx,
        items.length ? '🔗 Your invite links:' : 'No invite links yet.',
        kb,
        true,
      );
      return;
    }
    if (action === 'view') {
      const l = await this.invites.get(p.sourceId, id);
      const kb = new InlineKeyboard();
      if (l.active) kb.text('🚫 Revoke', `inv:revoke:${id}`);
      kb.text('⬅️ Back', 'inv:list');
      await this.render(
        ctx,
        `🔗 ${l.url}\nJoins: ${l.joinCount}\nActive: ${l.active ? 'yes' : 'no'}`,
        kb,
        true,
      );
      return;
    }
    if (action === 'new') {
      await this.invites.create(p.sourceId, {});
      await this.inv(ctx, p, 'list', '');
    }
    if (action === 'revoke') {
      await this.invites.revoke(p.sourceId, id);
      await this.inv(ctx, p, 'list', '');
    }
  }

  // ── Broadcast composer ─────────────────────────────────────────────────────

  private async bc(
    ctx: Context,
    p: AuthPrincipal,
    action: string,
    arg: string,
  ): Promise<void> {
    const session = getSession(ctx.from!.id);
    if (action === 'start') {
      session.broadcast = {};
      const items = await this.notifications.list(p.sourceId);
      const kb = new InlineKeyboard();
      items.forEach((n) => kb.text(`📝 ${n.name}`, `bc:notif:${n.id}`).row());
      kb.text('⬅️ Menu', 'menu:home');
      await this.render(
        ctx,
        items.length
          ? '📣 Pick a notification to send:'
          : 'Create a notification first.',
        kb,
        true,
      );
      return;
    }
    if (action === 'notif') {
      session.broadcast = { notificationId: arg };
      const groups = await this.groups.list(p.sourceId);
      const kb = new InlineKeyboard();
      groups.forEach((g) =>
        kb.text(`👥 ${g.name} (${g.memberCount})`, `bc:grp:${g.id}`).row(),
      );
      kb.text('⬅️ Back', 'bc:start');
      await this.render(ctx, '📣 Send to which group?', kb, true);
      return;
    }
    if (action === 'grp') {
      session.broadcast = { ...session.broadcast, groupId: arg };
      const n = await this.notifications.get(
        p.sourceId,
        session.broadcast.notificationId!,
      );
      if (n.placeholders.length) {
        session.awaiting = 'placeholders';
        await ctx.reply(
          `✏️ This message has placeholders: ${n.placeholders.join(', ')}\n` +
            `Reply with values, e.g. ${n.placeholders.map((x) => `${x}=...`).join(', ')}`,
        );
        return;
      }
      await this.showConfirm(ctx, p);
      return;
    }
    if (action === 'send') {
      await this.doSend(ctx, p);
    }
  }

  private async showConfirm(ctx: Context, p: AuthPrincipal): Promise<void> {
    const session = getSession(ctx.from!.id);
    const n = await this.notifications.get(
      p.sourceId,
      session.broadcast!.notificationId!,
    );
    const g = (await this.groups.list(p.sourceId)).find(
      (x) => x.id === session.broadcast!.groupId,
    );
    const kb = new InlineKeyboard()
      .text('✅ Send now', 'bc:send')
      .text('⬅️ Cancel', 'menu:home');
    await this.render(
      ctx,
      `📣 Send "${n.name}" to "${g?.name}" (${g?.memberCount} recipients)?`,
      kb,
      true,
    );
  }

  private async doSend(ctx: Context, p: AuthPrincipal): Promise<void> {
    const session = getSession(ctx.from!.id);
    const b = session.broadcast!;
    const view = await this.broadcasts.create(
      p.sourceId,
      {
        notificationId: b.notificationId!,
        groupIds: [b.groupId!],
        placeholderValues: b.placeholderValues ?? {},
        sendKey: `bot-${ctx.from!.id}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      },
      `telegram:${ctx.from!.id}`,
    );
    clearSession(ctx.from!.id);
    const kb = new InlineKeyboard().text('⬅️ Menu', 'menu:home');
    await this.render(
      ctx,
      `📣 Queued to ${view.totalCount} recipient(s). Delivery runs in the background.`,
      kb,
      false,
    );
  }

  // ── Free-text replies (group name, placeholder values) ─────────────────────

  private async onText(ctx: Context): Promise<void> {
    const text = ctx.message?.text ?? '';
    if (text.startsWith('/')) return; // commands handled elsewhere
    const principal = await this.requireOwner(ctx);
    if (!principal) return;
    const session = getSession(ctx.from!.id);

    if (session.awaiting === 'notif_name') {
      session.awaiting = 'notif_body';
      session.notifDraft = { name: text.trim() };
      await ctx.reply(
        '✏️ Now send the message body.\nUse {placeholders} like {name} to personalize per recipient.',
      );
      return;
    }

    if (session.awaiting === 'notif_body') {
      session.awaiting = undefined;
      const name = session.notifDraft?.name ?? 'Untitled';
      session.notifDraft = undefined;
      try {
        const n = await this.notifications.create(principal.sourceId, {
          name,
          body: text,
        });
        const ph = n.placeholders.length
          ? `\nPlaceholders detected: ${n.placeholders.join(', ')}`
          : '';
        await ctx.reply(`✅ Notification "${n.name}" created.${ph}`);
        await this.openHome(ctx, false);
      } catch (err) {
        await ctx.reply(`⚠️ ${(err as Error).message}`);
      }
      return;
    }

    if (session.awaiting === 'group_name') {
      session.awaiting = undefined;
      try {
        await this.groups.create(principal.sourceId, text.trim());
        await ctx.reply(`✅ Group "${text.trim()}" created.`);
        await this.openHome(ctx, false);
      } catch (err) {
        await ctx.reply(`⚠️ ${(err as Error).message}`);
      }
      return;
    }

    if (session.awaiting === 'placeholders') {
      session.awaiting = undefined;
      session.broadcast = {
        ...session.broadcast,
        placeholderValues: this.parseKeyValues(text),
      };
      try {
        await this.doSend(ctx, principal);
      } catch (err) {
        await ctx.reply(`⚠️ ${(err as Error).message}`);
      }
      return;
    }

    // Any other message from an owner → open the menu.
    await this.openHome(ctx, false);
  }

  private parseKeyValues(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const pair of text.split(',')) {
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const key = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (key) out[key] = value;
    }
    return out;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async requireOwner(ctx: Context): Promise<AuthPrincipal | null> {
    if (!ctx.from) return null;
    const principal = await this.sources.resolveByTelegramId(BigInt(ctx.from.id));
    if (!principal) {
      await ctx
        .reply('Open your workspace start link first to connect.')
        .catch(() => undefined);
      return null;
    }
    return principal;
  }

  /** Edit the existing message (smooth nav) or send a new one. */
  private async render(
    ctx: Context,
    text: string,
    keyboard: InlineKeyboard,
    edit: boolean,
  ): Promise<void> {
    const opts = { reply_markup: keyboard };
    if (edit && ctx.callbackQuery) {
      // "message is not modified" just means same content — safe to ignore.
      await ctx.editMessageText(text, opts).catch(() => undefined);
    } else {
      await ctx.reply(text, opts);
    }
  }
}
