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
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { type Bot, type Context, InlineKeyboard } from 'grammy';
import { clearSession, getSession } from './session';

/** Escape user/content text for HTML parse_mode (only these 3 are required). */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Turn a service exception into a short, human, actionable line. */
function humanError(err: unknown): string {
  if (err instanceof ConflictException) return (err as Error).message;
  if (err instanceof NotFoundException) return "That item no longer exists.";
  if (err instanceof BadRequestException) return (err as Error).message;
  const msg = (err as Error)?.message ?? 'Something went wrong.';
  // Never surface raw stack-ish text; keep it to one friendly sentence.
  return msg.length > 120 ? 'Something went wrong — please try again.' : msg;
}

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
    // Command shortcuts that jump straight to a menu screen (same renderers).
    bot.command('menu', (ctx) => this.openHome(ctx, false));
    bot.command('notifications', (ctx) => this.openList(ctx, 'notif'));
    bot.command('groups', (ctx) => this.openList(ctx, 'grp'));
    bot.command('links', (ctx) => this.openList(ctx, 'inv'));
    bot.command('send', (ctx) => this.openSend(ctx));
    bot.command('help', (ctx) => this.openHelp(ctx));
    // Callbacks + free-text must come after commands so commands win.
    bot.on('callback_query:data', (ctx) => this.onCallback(ctx));
    bot.on('message:text', (ctx) => this.onText(ctx));
  }

  /** /notifications, /groups, /links → open the matching list as a fresh card. */
  private async openList(ctx: Context, ns: 'notif' | 'grp' | 'inv'): Promise<void> {
    const p = await this.requireOwner(ctx);
    if (!p) return;
    if (ns === 'notif') await this.notif(ctx, p, 'list', '');
    else if (ns === 'grp') await this.grp(ctx, p, 'list', '');
    else await this.inv(ctx, p, 'list', '');
  }

  /** /send → open the broadcast composer. */
  private async openSend(ctx: Context): Promise<void> {
    const p = await this.requireOwner(ctx);
    if (!p) return;
    await this.bc(ctx, p, 'start', '');
  }

  /** /help → a short, friendly explainer (works for owners and subscribers). */
  private async openHelp(ctx: Context): Promise<void> {
    await ctx.reply(
      [
        '<b>Paedavic bot</b>',
        '',
        'Manage your notification workspace right here:',
        '📝 /notifications — create &amp; manage message templates',
        '👥 /groups — organize subscribers into segments',
        '🔗 /links — invite links that subscribe &amp; segment people',
        '📣 /send — send a broadcast',
        '🏠 /menu — open the main menu',
        '',
        'Subscribers can use /stop to unsubscribe anytime.',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
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
      if (ns === 'noop') return; // pagination label tap — already acked
      if (ns === 'menu') return void (await this.openHome(ctx, true));
      if (ns === 'notif') return void (await this.notif(ctx, principal, action, arg));
      if (ns === 'grp') return void (await this.grp(ctx, principal, action, arg));
      if (ns === 'inv') return void (await this.inv(ctx, principal, action, arg));
      if (ns === 'bc') return void (await this.bc(ctx, principal, action, arg));
    } catch (err) {
      this.logger.error(`menu action "${data}" failed: ${(err as Error).message}`);
      await ctx
        .answerCallbackQuery({ text: `⚠️ ${humanError(err)}`, show_alert: true })
        .catch(() => undefined);
    }
  }

  // ── Notifications ──────────────────────────────────────────────────────────

  private async notif(
    ctx: Context,
    p: AuthPrincipal,
    action: string,
    id: string,
    flash?: string,
  ): Promise<void> {
    if (action === 'list') {
      const items = await this.notifications.list(p.sourceId);
      const { slice, pg, pages } = this.paginate(items, parseInt(id || '0', 10) || 0);
      const kb = new InlineKeyboard();
      slice.forEach((n) => kb.text(`📝 ${n.name}`, `notif:view:${n.id}`).row());
      this.navRow(kb, 'notif:list:', pg, pages);
      kb.text('➕ New notification', 'notif:new').row();
      kb.text('🏠 Menu', 'menu:home');
      const header = items.length
        ? '<b>📝 Notifications</b>'
        : '<b>📝 Notifications</b>\n\n📭 None yet — tap ➕ to create one.';
      await this.render(ctx, this.flash(flash) + header, kb, true);
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
      const ph = n.placeholders.length
        ? n.placeholders.map((x) => `{${x}}`).join(', ')
        : 'none';
      const kb = new InlineKeyboard()
        .text('📋 Duplicate', `notif:dup:${id}`)
        .text('🗑 Archive', `notif:arch:${id}`)
        .row()
        .text('⬅️ Back', 'notif:list');
      await this.render(
        ctx,
        `<b>📝 ${esc(n.name)}</b>\n\n${esc(n.body)}\n\n<i>Placeholders:</i> ${esc(ph)}`,
        kb,
        true,
      );
      return;
    }
    if (action === 'dup') {
      await this.notifications.duplicate(p.sourceId, id);
      await this.notif(ctx, p, 'list', '', '✅ Duplicated');
      return;
    }
    if (action === 'arch') {
      const n = await this.notifications.get(p.sourceId, id);
      const kb = new InlineKeyboard()
        .text('✅ Archive', `notif:archY:${id}`)
        .text('✖ Cancel', `notif:view:${id}`);
      await this.render(
        ctx,
        `🗑 Archive <b>${esc(n.name)}</b>?\nIt will be hidden from your gallery.`,
        kb,
        true,
      );
      return;
    }
    if (action === 'archY') {
      await this.notifications.archive(p.sourceId, id);
      await this.notif(ctx, p, 'list', '', '✅ Archived');
      return;
    }
  }

  /** A one-line success/status banner prepended to a re-rendered screen. */
  private flash(text?: string): string {
    return text ? `<i>${esc(text)}</i>\n\n` : '';
  }

  private static readonly PAGE = 8;

  /** Slice an array into a page; clamps the requested page into range. */
  private paginate<T>(items: T[], page: number) {
    const size = AdminMenu.PAGE;
    const pages = Math.max(1, Math.ceil(items.length / size));
    const pg = Math.min(Math.max(0, page), pages - 1);
    return { slice: items.slice(pg * size, (pg + 1) * size), pg, pages };
  }

  /** Append a "◀ x/y ▶" nav row to a keyboard when there's more than one page. */
  private navRow(
    kb: InlineKeyboard,
    prefix: string,
    pg: number,
    pages: number,
  ): void {
    if (pages <= 1) return;
    if (pg > 0) kb.text('◀', `${prefix}${pg - 1}`);
    kb.text(`${pg + 1}/${pages}`, 'noop');
    if (pg < pages - 1) kb.text('▶', `${prefix}${pg + 1}`);
    kb.row();
  }

  // ── Groups ─────────────────────────────────────────────────────────────────

  private async grp(
    ctx: Context,
    p: AuthPrincipal,
    action: string,
    id: string,
    flash?: string,
  ): Promise<void> {
    if (action === 'list') {
      const items = await this.groups.list(p.sourceId);
      const { slice, pg, pages } = this.paginate(items, parseInt(id || '0', 10) || 0);
      const kb = new InlineKeyboard();
      slice.forEach((g) =>
        kb.text(`👥 ${g.name} (${g.memberCount})`, `grp:view:${g.id}`).row(),
      );
      this.navRow(kb, 'grp:list:', pg, pages);
      kb.text('➕ New group', 'grp:new').row();
      kb.text('🏠 Menu', 'menu:home');
      await this.render(ctx, this.flash(flash) + '<b>👥 Groups</b>', kb, true);
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
      const note = g.isAll ? '\n<i>Everyone is automatically in this group.</i>' : '';
      await this.render(
        ctx,
        `<b>👥 ${esc(g.name)}</b>\nMembers: ${g.memberCount}${note}`,
        kb,
        true,
      );
      return;
    }
    if (action === 'mem') {
      // Toggle UI: every active subscriber with a ✅/⬜ marker for membership.
      const [groupId, pageStr] = id.split(':');
      await this.renderMembers(ctx, p, groupId, undefined, parseInt(pageStr || '0', 10) || 0);
      return;
    }
    if (action === 'tog') {
      const [groupId, subscriberId, pageStr] = id.split(':');
      const page = parseInt(pageStr || '0', 10) || 0;
      const memberIds = await this.memberIdSet(p, groupId);
      let flashMsg: string;
      if (memberIds.has(subscriberId)) {
        await this.groups.removeMember(p.sourceId, groupId, subscriberId);
        flashMsg = '➖ Removed';
      } else {
        await this.groups.addMembers(p.sourceId, groupId, [subscriberId]);
        flashMsg = '➕ Added';
      }
      await this.renderMembers(ctx, p, groupId, flashMsg, page);
      return;
    }
    if (action === 'del') {
      const g = (await this.groups.list(p.sourceId)).find((x) => x.id === id);
      const kb = new InlineKeyboard()
        .text('✅ Delete', `grp:delY:${id}`)
        .text('✖ Cancel', `grp:view:${id}`);
      await this.render(
        ctx,
        `🗑 Delete group <b>${esc(g?.name ?? '')}</b>?\nMembers stay subscribed; only the segment is removed.`,
        kb,
        true,
      );
      return;
    }
    if (action === 'delY') {
      await this.groups.delete(p.sourceId, id);
      await this.grp(ctx, p, 'list', '', '✅ Group deleted');
      return;
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
    flash?: string,
    page = 0,
  ): Promise<void> {
    const [all, memberIds] = await Promise.all([
      this.subscribers.list(p.sourceId),
      this.memberIdSet(p, groupId),
    ]);
    const { slice, pg, pages } = this.paginate(all, page);
    const kb = new InlineKeyboard();
    slice.forEach((s) => {
      const label = s.username ? `@${s.username}` : s.telegramUserId;
      kb.text(
        `${memberIds.has(s.id) ? '✅' : '⬜'} ${label}`,
        `grp:tog:${groupId}:${s.id}:${pg}`,
      ).row();
    });
    this.navRow(kb, `grp:mem:${groupId}:`, pg, pages);
    kb.text('⬅️ Back', `grp:view:${groupId}`);
    const body = all.length
      ? 'Tap a subscriber to add or remove them:'
      : '📭 No subscribers yet — share an invite link first.';
    await this.render(ctx, this.flash(flash) + body, kb, true);
  }

  // ── Invite links ───────────────────────────────────────────────────────────

  private async inv(
    ctx: Context,
    p: AuthPrincipal,
    action: string,
    id: string,
    flash?: string,
  ): Promise<void> {
    if (action === 'list') {
      const items = await this.invites.list(p.sourceId);
      const { slice, pg, pages } = this.paginate(items, parseInt(id || '0', 10) || 0);
      const kb = new InlineKeyboard();
      slice.forEach((l) =>
        kb
          .text(
            `🔗 ${l.joinCount} joins${l.active ? '' : ' · revoked'}`,
            `inv:view:${l.id}`,
          )
          .row(),
      );
      this.navRow(kb, 'inv:list:', pg, pages);
      kb.text('➕ New link', 'inv:new').row();
      kb.text('🏠 Menu', 'menu:home');
      const header = items.length
        ? '<b>🔗 Invite links</b>'
        : '<b>🔗 Invite links</b>\n\n📭 None yet — tap ➕ to create one.';
      await this.render(ctx, this.flash(flash) + header, kb, true);
      return;
    }
    if (action === 'view') {
      const l = await this.invites.get(p.sourceId, id);
      const kb = new InlineKeyboard();
      if (l.active) kb.text('🚫 Revoke', `inv:revoke:${id}`);
      kb.text('⬅️ Back', 'inv:list');
      const status = l.active ? '🟢 active' : '🔴 revoked';
      await this.render(
        ctx,
        `<b>🔗 Invite link</b> (${status})\n` +
          `Joins: ${l.joinCount}\n\n<code>${esc(l.url)}</code>`,
        kb,
        true,
      );
      return;
    }
    if (action === 'new') {
      await this.invites.create(p.sourceId, {});
      await this.inv(ctx, p, 'list', '', '✅ Link created');
      return;
    }
    if (action === 'revoke') {
      const kb = new InlineKeyboard()
        .text('✅ Revoke', `inv:revokeY:${id}`)
        .text('✖ Cancel', `inv:view:${id}`);
      await this.render(
        ctx,
        '🚫 Revoke this link?\nPeople who already joined stay subscribed; the link stops working.',
        kb,
        true,
      );
      return;
    }
    if (action === 'revokeY') {
      await this.invites.revoke(p.sourceId, id);
      await this.inv(ctx, p, 'list', '', '✅ Link revoked');
      return;
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
      .text('✖ Cancel', 'menu:home');
    await this.render(
      ctx,
      `📣 Send <b>${esc(n.name)}</b> to <b>${esc(g?.name ?? '')}</b>?\n` +
        `${g?.memberCount ?? 0} recipient(s).`,
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
        .reply(
          "👋 You're not connected to a workspace yet.\nOpen your start link to begin, or tap /help.",
        )
        .catch(() => undefined);
      return null;
    }
    return principal;
  }

  /**
   * Edit the existing message (smooth nav) or send a new one. Always HTML —
   * callers escape dynamic content with esc(); static labels are HTML-safe.
   */
  private async render(
    ctx: Context,
    text: string,
    keyboard: InlineKeyboard,
    edit: boolean,
  ): Promise<void> {
    const opts = {
      reply_markup: keyboard,
      parse_mode: 'HTML' as const,
      link_preview_options: { is_disabled: true },
    };
    if (edit && ctx.callbackQuery) {
      // "message is not modified" just means same content — safe to ignore.
      await ctx.editMessageText(text, opts).catch(() => undefined);
    } else {
      await ctx.reply(text, opts);
    }
  }
}
