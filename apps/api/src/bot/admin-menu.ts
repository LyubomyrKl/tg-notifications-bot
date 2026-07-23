import { Injectable, Logger } from '@nestjs/common';
import {
  answerCallback,
  type AuthPrincipal,
  BroadcastService,
  GroupService,
  InviteService,
  NotificationService,
  ResponseService,
  ScheduleService,
  SourceService,
  SubscriberService,
  voteCallback,
} from '@paedavic/core';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { NotificationView } from '@paedavic/contracts';
import { conversations, createConversation } from '@grammyjs/conversations';
import { type Bot, type Context, InlineKeyboard } from 'grammy';

/** Shape Telegram's setMyCommands expects. */
type BotCommand = { command: string; description: string };
import { clearSession, getSession } from './session';

/** grammY conversations replay their builder; service calls are wrapped in
 *  conversation.external() so side effects run exactly once. Typed loosely
 *  (`any`) to avoid threading the ConversationFlavor generic through the
 *  default-typed Bot from @paedavic/telegram. */
type Conv = {
  wait(): Promise<Context>;
  external<T>(cb: () => T | Promise<T>): Promise<T>;
};

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
    private readonly schedule: ScheduleService,
    private readonly responses: ResponseService,
  ) {}

  /**
   * Single source of truth for this menu's commands: name + Telegram-menu
   * description + handler. Drives BOTH the `bot.command(...)` wiring (below) and
   * the `setMyCommands` list (via {@link menuCommands}) — so the two can't drift.
   * (`/start` and `/stop` are owned by BotRunner and added around these.)
   */
  private readonly menuCommandDefs: ReadonlyArray<{
    command: string;
    description: string;
    run: (ctx: Context) => Promise<void>;
  }> = [
    { command: 'menu', description: 'Open the main menu', run: (c) => this.openHome(c, false) },
    { command: 'notifications', description: 'Message templates', run: (c) => this.openList(c, 'notif') },
    { command: 'groups', description: 'Subscriber groups', run: (c) => this.openList(c, 'grp') },
    { command: 'links', description: 'Invite links', run: (c) => this.openList(c, 'inv') },
    { command: 'send', description: 'Send a broadcast', run: (c) => this.openSend(c) },
    { command: 'subscribers', description: 'Subscribers', run: (c) => this.openSubscribers(c) },
    { command: 'scheduled', description: 'Upcoming scheduled sends', run: (c) => this.openScheduled(c) },
    { command: 'help', description: 'How this bot works', run: (c) => this.openHelp(c) },
  ];

  /** The {command, description} list for Telegram's command menu (setMyCommands). */
  menuCommands(): BotCommand[] {
    return this.menuCommandDefs.map(({ command, description }) => ({ command, description }));
  }

  /** Wire the menu onto the bot. Call after command handlers are registered. */
  register(bot: Bot): void {
    // Command shortcuts that jump straight to a menu screen — from the registry.
    for (const c of this.menuCommandDefs) bot.command(c.command, (ctx) => c.run(ctx));
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

  /** /subscribers → list subscribers. */
  private async openSubscribers(ctx: Context): Promise<void> {
    const p = await this.requireOwner(ctx);
    if (!p) return;
    await this.sub(ctx, p, 'list', '');
  }

  /** /scheduled → list upcoming scheduled broadcasts. */
  private async openScheduled(ctx: Context): Promise<void> {
    const p = await this.requireOwner(ctx);
    if (!p) return;
    await this.sch(ctx, p, 'list', '');
  }

  /** /help → role-aware: owners see the admin explainer; consumers/strangers get
   *  the reader card / connect prompt (no admin commands to explain to them). */
  private async openHelp(ctx: Context): Promise<void> {
    const tgId = ctx.from ? BigInt(ctx.from.id) : null;
    const isOwner = tgId
      ? !!(await this.sources.resolveByTelegramId(tgId))
      : false;
    if (!isOwner) {
      if (tgId) return void (await this.replyNonOwner(ctx, tgId));
      return void (await ctx.reply(
        '👋 Open a workspace invite or start link to get connected.',
      ));
    }
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
    await this.render(ctx, '<b>🏠 Menu</b>\nWhat would you like to do?', this.homeKeyboard(), edit);
  }

  // ── Callback router ────────────────────────────────────────────────────────

  private async onCallback(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? '';
    const [ns, action, ...rest] = data.split(':');
    const arg = rest.join(':'); // e.g. "groupId:subscriberId" for toggles

    // Subscriber responses (poll vote / answer prompt) work for ANY user, not
    // just owners — handle them before the owner gate. They ack the spinner
    // themselves (with a confirmation toast).
    if (ns === 'rv' || ns === 'ra') {
      return void (await this.onResponseCallback(ctx, ns, action, arg));
    }

    await ctx.answerCallbackQuery().catch(() => undefined); // ack the spinner
    const principal = await this.requireOwner(ctx);
    if (!principal) return;

    try {
      if (ns === 'noop') return; // pagination label tap — already acked
      if (ns === 'menu') return void (await this.openHome(ctx, true));
      if (ns === 'notif') return void (await this.notif(ctx, principal, action, arg));
      if (ns === 'grp') return void (await this.grp(ctx, principal, action, arg));
      if (ns === 'inv') return void (await this.inv(ctx, principal, action, arg));
      if (ns === 'bc') return void (await this.bc(ctx, principal, action, arg));
      if (ns === 'sch') return void (await this.sch(ctx, principal, action, arg));
      if (ns === 'sub') return void (await this.sub(ctx, principal, action, arg));
      if (ns === 'res') return void (await this.res(ctx, principal, action, arg));
    } catch (err) {
      this.logger.error(`menu action "${data}" failed: ${(err as Error).message}`);
      await ctx
        .answerCallbackQuery({ text: `⚠️ ${humanError(err)}`, show_alert: true })
        .catch(() => undefined);
    }
  }

  /**
   * A subscriber tapped a poll option (`rv:<broadcastId>:<idx>`) or the Answer
   * button (`ra:<broadcastId>`). Records the vote inline, or opens the guided
   * answer flow. Not owner-gated — the recorder validates active membership.
   */
  private async onResponseCallback(
    ctx: Context,
    ns: string,
    broadcastId: string,
    arg: string,
  ): Promise<void> {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    try {
      if (ns === 'rv') {
        const { label } = await this.responses.recordVote(
          broadcastId,
          tgId,
          parseInt(arg, 10),
        );
        await ctx
          .answerCallbackQuery({ text: `✅ Recorded: ${label}` })
          .catch(() => undefined);
        return;
      }
      // ns === 'ra' → open the free-text answer conversation.
      await ctx.answerCallbackQuery().catch(() => undefined);
      await this.enterConvo(ctx, 'answerQuestion', broadcastId);
    } catch (err) {
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
      await (ctx as unknown as { conversation: { enter(id: string): Promise<void> } })
        .conversation.enter('createNotif');
      return;
    }
    if (action === 'view') {
      const n = await this.notifications.get(p.sourceId, id);
      const ph = n.placeholders.length
        ? n.placeholders.map((x) => `{${x}}`).join(', ')
        : 'none';
      const kb = new InlineKeyboard()
        .text('✏️ Edit', `notif:edit:${id}`)
        .text('📋 Duplicate', `notif:dup:${id}`)
        .row()
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
    if (action === 'edit') {
      await (
        ctx as unknown as {
          conversation: { enter(id: string, ...a: string[]): Promise<void> };
        }
      ).conversation.enter('editNotif', id);
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
      await (ctx as unknown as { conversation: { enter(id: string): Promise<void> } })
        .conversation.enter('createGroup');
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
      const bound = l.groupId ? '\n<i>New joiners are auto-added to a group.</i>' : '';
      await this.render(
        ctx,
        this.flash(flash) +
          `<b>🔗 Invite link</b> (${status})\n` +
          `Joins: ${l.joinCount}${bound}\n\n<code>${esc(l.url)}</code>`,
        kb,
        true,
      );
      return;
    }
    if (action === 'new') {
      // Optionally bind the link to a group so joiners are auto-added.
      const groups = (await this.groups.list(p.sourceId)).filter((g) => !g.isAll);
      const kb = new InlineKeyboard().text('🔗 No group (anyone)', 'inv:mk').row();
      groups.forEach((g) => kb.text(`👥 ${g.name}`, `inv:mk:${g.id}`).row());
      kb.text('⬅️ Back', 'inv:list');
      await this.render(
        ctx,
        '<b>🔗 New invite link</b>\nBind it to a group (joiners auto-added), or pick none:',
        kb,
        true,
      );
      return;
    }
    if (action === 'mk') {
      const link = await this.invites.create(p.sourceId, id ? { groupId: id } : {});
      await this.inv(ctx, p, 'view', link.id, '✅ Link created');
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
      session.broadcast = { groupIds: [] };
      const items = await this.notifications.list(p.sourceId);
      const kb = new InlineKeyboard();
      items.forEach((n) => kb.text(`📝 ${n.name}`, `bc:notif:${n.id}`).row());
      kb.text('✍️ Write a new message', 'bc:new').row();
      kb.text('🏠 Menu', 'menu:home');
      await this.render(
        ctx,
        items.length
          ? '<b>📣 Broadcast</b>\nPick a saved message, or write a new one:'
          : '<b>📣 Broadcast</b>\n\nNo saved messages yet — tap ✍️ to write one.',
        kb,
        true,
      );
      return;
    }
    if (action === 'notif') {
      // Preview the picked template, then choose how to use it: send it verbatim,
      // or take it as a base and write something on top for this send only.
      const n = await this.notifications.get(p.sourceId, arg);
      const kb = new InlineKeyboard()
        .text('➡️ Use as is', `bc:use:${n.id}`)
        .row()
        .text('✏️ Add text on top', `bc:adjust:${n.id}`)
        .row()
        .text('⬅️ Back', 'bc:start');
      await this.render(ctx, this.notifPreview(n), kb, true);
      return;
    }
    if (action === 'use') {
      session.broadcast = { notificationId: arg, groupIds: [], subscriberIds: [] };
      await this.renderGroupSelect(ctx, p);
      return;
    }
    if (action === 'new') {
      await this.enterConvo(ctx, 'composeBroadcastMsg');
      return;
    }
    if (action === 'adjust') {
      await this.enterConvo(ctx, 'adjustBroadcastMsg', arg);
      return;
    }
    if (action === 'gtog') {
      const ids = session.broadcast?.groupIds ?? [];
      const i = ids.indexOf(arg);
      if (i >= 0) ids.splice(i, 1);
      else ids.push(arg);
      session.broadcast = { ...session.broadcast, groupIds: ids };
      await this.renderGroupSelect(ctx, p);
      return;
    }
    if (action === 'groups') {
      await this.renderGroupSelect(ctx, p);
      return;
    }
    if (action === 'people') {
      await this.renderSubscriberSelect(ctx, p, parseInt(arg || '0', 10) || 0);
      return;
    }
    if (action === 'stog') {
      // arg is "subscriberId:page" — keep the page so the list doesn't jump.
      const [subId, pageStr] = arg.split(':');
      const ids = session.broadcast?.subscriberIds ?? [];
      const i = ids.indexOf(subId);
      if (i >= 0) ids.splice(i, 1);
      else ids.push(subId);
      session.broadcast = { ...session.broadcast, subscriberIds: ids };
      await this.renderSubscriberSelect(ctx, p, parseInt(pageStr || '0', 10) || 0);
      return;
    }
    if (action === 'go') {
      const b = session.broadcast;
      if (!b?.notificationId || !this.hasTargets(b)) {
        await this.renderGroupSelect(ctx, p);
        return;
      }
      // Offer an optional interaction before the send/schedule choice.
      const kb = new InlineKeyboard()
        .text('➡️ Just send', 'bc:react:none')
        .row()
        .text('📊 Poll', 'bc:react:poll')
        .text('❓ Question', 'bc:react:q')
        .row()
        .text('✖ Cancel', 'menu:home');
      await this.render(
        ctx,
        '📣 <b>Add a response option?</b>\n' +
          '<i>Poll = recipients tap a button · Question = they reply with text.</i>',
        kb,
        true,
      );
      return;
    }
    if (action === 'react') {
      const b = session.broadcast;
      if (!b?.notificationId || !this.hasTargets(b)) {
        await this.renderGroupSelect(ctx, p);
        return;
      }
      if (arg === 'poll') {
        await this.enterConvo(ctx, 'pollSetup'); // collects options, then send choice
        return;
      }
      session.broadcast = {
        ...b,
        interaction: arg === 'q' ? { type: 'question', options: [] } : undefined,
      };
      await this.renderSendChoice(ctx);
      return;
    }
    if (action === 'now') {
      const b = session.broadcast!;
      const n = await this.notifications.get(p.sourceId, b.notificationId!);
      if (n.placeholders.length) {
        await this.enterConvo(
          ctx,
          'bcFill',
          b.notificationId!,
          (b.groupIds ?? []).join(','),
          (b.subscriberIds ?? []).join(','),
          JSON.stringify(b.interaction ?? null),
        );
        return;
      }
      await this.showConfirm(ctx, p);
      return;
    }
    if (action === 'sched') {
      const b = session.broadcast;
      // Scheduling targets groups only (a ScheduledBroadcast has no subscriber
      // list); direct recipients are an immediate-send feature.
      if (!b?.notificationId || !b.groupIds?.length) {
        await this.renderGroupSelect(ctx, p);
        return;
      }
      await this.enterConvo(ctx, 'scheduleBroadcast', b.notificationId, b.groupIds.join(','));
      return;
    }
    if (action === 'send') {
      await this.doSend(ctx, p);
    }
  }

  /**
   * The send-now / schedule choice. Interactive sends (poll/question) go out
   * immediately — scheduling them is a v1 non-goal — so Schedule is hidden once
   * an interaction is attached.
   */
  private async renderSendChoice(ctx: Context): Promise<void> {
    const b = getSession(ctx.from!.id).broadcast;
    const tag = b?.interaction
      ? b.interaction.type === 'poll'
        ? `\n<i>📊 Poll: ${b.interaction.options.map(esc).join(' · ')}</i>`
        : '\n<i>❓ Question — recipients can reply.</i>'
      : '';
    const kb = new InlineKeyboard().text('✅ Send now', 'bc:now');
    // Scheduling supports groups only — hide it once an interaction or direct
    // recipients are in play (both are immediate-send features).
    const canSchedule = !b?.interaction && !(b?.subscriberIds?.length);
    if (canSchedule) kb.text('⏰ Schedule', 'bc:sched');
    kb.row().text('✖ Cancel', 'menu:home');
    await this.render(ctx, `📣 Send now, or schedule for later?${tag}`, kb, true);
  }

  /** True when a broadcast has at least one target group or direct subscriber. */
  private hasTargets(b: {
    groupIds?: string[];
    subscriberIds?: string[];
  }): boolean {
    return !!(b.groupIds?.length || b.subscriberIds?.length);
  }

  /** Enter a grammY conversation (typed loosely; plugin adds ctx.conversation). */
  private enterConvo(ctx: Context, id: string, ...args: string[]): Promise<void> {
    return (
      ctx as unknown as {
        conversation: { enter(id: string, ...a: string[]): Promise<void> };
      }
    ).conversation.enter(id, ...args);
  }

  // ── Scheduled broadcasts ────────────────────────────────────────────────────

  private async sch(
    ctx: Context,
    p: AuthPrincipal,
    action: string,
    id: string,
    flash?: string,
  ): Promise<void> {
    if (action === 'list') {
      const upcoming = (await this.schedule.list(p.sourceId)).filter(
        (s) => s.status === 'scheduled',
      );
      const { slice, pg, pages } = this.paginate(upcoming, parseInt(id || '0', 10) || 0);
      const kb = new InlineKeyboard();
      slice.forEach((s) => {
        const rep = s.repeat === 'none' ? 'once' : s.repeat;
        kb.text(`⏰ ${this.formatWhen(s.sendAt)} · ${rep}`, `sch:view:${s.id}`).row();
      });
      this.navRow(kb, 'sch:list:', pg, pages);
      kb.text('🏠 Menu', 'menu:home');
      const header = upcoming.length
        ? '<b>⏰ Scheduled</b>'
        : '<b>⏰ Scheduled</b>\n\n📭 Nothing scheduled — send a broadcast and pick “⏰ Schedule”.';
      await this.render(ctx, this.flash(flash) + header, kb, true);
      return;
    }
    if (action === 'view') {
      const s = await this.schedule.get(p.sourceId, id);
      const rep = s.repeat === 'none' ? 'once' : s.repeat;
      const kb = new InlineKeyboard();
      if (s.status === 'scheduled') kb.text('🚫 Cancel', `sch:cancel:${id}`).row();
      kb.text('⬅️ Back', 'sch:list');
      await this.render(
        ctx,
        `<b>⏰ Scheduled broadcast</b>\nWhen: ${this.formatWhen(s.sendAt)} UTC\n` +
          `Repeat: ${rep}\nStatus: ${s.status}`,
        kb,
        true,
      );
      return;
    }
    if (action === 'cancel') {
      const kb = new InlineKeyboard()
        .text('✅ Cancel it', `sch:cancelY:${id}`)
        .text('✖ Keep', `sch:view:${id}`);
      await this.render(ctx, '🚫 Cancel this scheduled send?', kb, true);
      return;
    }
    if (action === 'cancelY') {
      await this.schedule.cancel(p.sourceId, id);
      await this.sch(ctx, p, 'list', '', '✅ Cancelled');
      return;
    }
  }

  // ── Subscribers ─────────────────────────────────────────────────────────────

  /**
   * Per-subscriber management: browse the roster, then send a one-off message,
   * reassign to a group (a clean move), or unsubscribe. The direct-send flow
   * reuses the broadcast machinery with a single subscriberId (no group).
   */
  private async sub(
    ctx: Context,
    p: AuthPrincipal,
    action: string,
    arg: string,
    flash?: string,
  ): Promise<void> {
    const session = getSession(ctx.from!.id);

    if (action === 'list') {
      const all = await this.subscribers.list(p.sourceId);
      const { slice, pg, pages } = this.paginate(all, parseInt(arg || '0', 10) || 0);
      const kb = new InlineKeyboard();
      slice.forEach((s) => {
        const label = s.username ? `@${s.username}` : s.telegramUserId;
        kb.text(`👤 ${label}`, `sub:view:${s.id}`).row();
      });
      this.navRow(kb, 'sub:list:', pg, pages);
      kb.text('🏠 Menu', 'menu:home');
      const header = all.length
        ? '<b>👤 Subscribers</b>\nTap someone to message or manage them.'
        : '<b>👤 Subscribers</b>\n\n📭 None yet — share an invite link first.';
      await this.render(ctx, this.flash(flash) + header, kb, true);
      return;
    }

    if (action === 'view') {
      const s = (await this.subscribers.list(p.sourceId)).find((x) => x.id === arg);
      if (!s) return void (await this.sub(ctx, p, 'list', '', '⚠️ Subscriber not found'));
      const label = s.username ? `@${s.username}` : s.telegramUserId;
      const kb = new InlineKeyboard()
        .text('📨 Send message', `sub:send:${s.id}`)
        .row()
        .text('➿ Move to group', `sub:move:${s.id}`)
        .row()
        .text('🚫 Unsubscribe', `sub:unsub:${s.id}`)
        .row()
        .text('⬅️ Back', 'sub:list');
      await this.render(
        ctx,
        this.flash(flash) +
          `<b>👤 ${esc(label)}</b>\n<code>${s.telegramUserId}</code>\n` +
          `Status: ${s.status} · joined ${this.formatWhen(s.joinedAt)} UTC`,
        kb,
        true,
      );
      return;
    }

    if (action === 'send') {
      // Fresh single-recipient broadcast: pick which notification to send.
      session.broadcast = { subscriberIds: [arg], groupIds: [] };
      const items = await this.notifications.list(p.sourceId);
      const kb = new InlineKeyboard();
      items.forEach((n) => kb.text(`📝 ${n.name}`, `sub:pick:${arg}:${n.id}`).row());
      kb.text('⬅️ Back', `sub:view:${arg}`);
      await this.render(
        ctx,
        items.length
          ? '<b>📨 Send message</b>\nPick a notification to send:'
          : '<b>📨 Send message</b>\n\n📭 Create a notification first.',
        kb,
        true,
      );
      return;
    }

    if (action === 'pick') {
      // arg is "subscriberId:notificationId".
      const sep = arg.lastIndexOf(':');
      const subId = arg.slice(0, sep);
      const notifId = arg.slice(sep + 1);
      session.broadcast = {
        notificationId: notifId,
        groupIds: [],
        subscriberIds: [subId],
      };
      const n = await this.notifications.get(p.sourceId, notifId);
      if (n.placeholders.length) {
        await this.enterConvo(ctx, 'bcFill', notifId, '', subId);
        return;
      }
      await this.doSend(ctx, p);
      return;
    }

    if (action === 'move') {
      const groups = (await this.groups.list(p.sourceId)).filter((g) => !g.isAll);
      const kb = new InlineKeyboard();
      groups.forEach((g) =>
        kb.text(`👥 ${g.name} (${g.memberCount})`, `sub:mv:${arg}:${g.id}`).row(),
      );
      kb.text('⬅️ Back', `sub:view:${arg}`);
      await this.render(
        ctx,
        groups.length
          ? '<b>➿ Move to group</b>\nPick the group. They’ll be removed from any others.'
          : '<b>➿ Move to group</b>\n\n📭 Create a group first.',
        kb,
        true,
      );
      return;
    }

    if (action === 'mv') {
      // arg is "subscriberId:groupId".
      const sep = arg.lastIndexOf(':');
      const subId = arg.slice(0, sep);
      const groupId = arg.slice(sep + 1);
      const g = await this.groups.moveMember(p.sourceId, subId, groupId);
      await this.sub(ctx, p, 'view', subId, `✅ Moved to ${g.name}`);
      return;
    }

    if (action === 'unsub') {
      const kb = new InlineKeyboard()
        .text('✅ Unsubscribe', `sub:unsubY:${arg}`)
        .text('✖ Cancel', `sub:view:${arg}`);
      await this.render(
        ctx,
        '🚫 Unsubscribe this person?\nThey stop receiving broadcasts until they re-join.',
        kb,
        true,
      );
      return;
    }

    if (action === 'unsubY') {
      await this.subscribers.unsubscribe(p.sourceId, arg);
      await this.sub(ctx, p, 'list', '', '✅ Unsubscribed');
      return;
    }
  }

  // ── Responses (poll tallies + free-text answers) ────────────────────────────

  private async res(
    ctx: Context,
    p: AuthPrincipal,
    action: string,
    arg: string,
  ): Promise<void> {
    if (action === 'list') {
      const [all, notifs] = await Promise.all([
        this.broadcasts.list(p.sourceId),
        // Include ephemeral one-offs so a one-time poll/question still shows a name.
        this.notifications.list(p.sourceId, { includeEphemeral: true }),
      ]);
      const interactive = all.filter((b) => b.interaction.type !== 'none');
      const names = new Map(notifs.map((n) => [n.id, n.name]));
      const { slice, pg, pages } = this.paginate(
        interactive,
        parseInt(arg || '0', 10) || 0,
      );
      const kb = new InlineKeyboard();
      slice.forEach((b) => {
        const icon = b.interaction.type === 'poll' ? '📊' : '❓';
        const name = names.get(b.notificationId) ?? 'broadcast';
        kb.text(
          `${icon} ${name} · ${b.responseCount} ${b.responseCount === 1 ? 'reply' : 'replies'}`,
          `res:view:${b.id}`,
        ).row();
      });
      this.navRow(kb, 'res:list:', pg, pages);
      kb.text('🏠 Menu', 'menu:home');
      const header = interactive.length
        ? '<b>📥 Responses</b>\nPick an interactive broadcast to see replies.'
        : '<b>📥 Responses</b>\n\n📭 No polls or questions sent yet.';
      await this.render(ctx, header, kb, true);
      return;
    }

    if (action === 'view') {
      const data = await this.responses.list(p.sourceId, arg);
      const kb = new InlineKeyboard().text('⬅️ Back', 'res:list');
      let body: string;
      if (data.interaction.type === 'poll') {
        const total = data.responses.length;
        const lines = data.tallies.map((t) => {
          const pct = total ? Math.round((t.count / total) * 100) : 0;
          return `${esc(t.label)} — <b>${t.count}</b> (${pct}%)`;
        });
        body =
          `<b>📊 Poll results</b> · ${total} ${total === 1 ? 'vote' : 'votes'}\n\n` +
          (lines.join('\n') || 'No votes yet.');
      } else {
        const lines = data.responses.map((r) => {
          const who = r.username ? `@${r.username}` : `#${r.telegramUserId}`;
          return `<b>${esc(who)}</b>: ${esc(r.text ?? '')}`;
        });
        body =
          `<b>❓ Answers</b> · ${data.responses.length}\n\n` +
          (lines.join('\n\n') || 'No answers yet.');
      }
      await this.render(ctx, body, kb, true);
      return;
    }
  }

  /** Compact UTC label, e.g. "Jul 5 14:30". */
  private formatWhen(iso: string): string {
    const d = new Date(iso);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${months[d.getUTCMonth()]} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }

  /** A read-only card for a picked template: name, body (clipped), placeholders. */
  private notifPreview(n: NotificationView): string {
    const body = n.body.length > 600 ? `${n.body.slice(0, 600)}…` : n.body;
    const ph = n.placeholders.length
      ? `\n\n<i>Placeholders:</i> ${esc(n.placeholders.map((x) => `{${x}}`).join(', '))}`
      : '';
    return `<b>📝 ${esc(n.name)}</b>\n\n${esc(body)}${ph}`;
  }

  /** Multi-select group picker for a broadcast (✅/⬜ toggles + Continue). Also
   *  the entry point to the individual-people picker. */
  private async renderGroupSelect(ctx: Context, p: AuthPrincipal): Promise<void> {
    const session = getSession(ctx.from!.id);
    const b = session.broadcast;
    const selected = new Set(b?.groupIds ?? []);
    const peopleCount = b?.subscriberIds?.length ?? 0;
    const groups = await this.groups.list(p.sourceId);
    const kb = new InlineKeyboard();
    groups.forEach((g) =>
      kb
        .text(
          `${selected.has(g.id) ? '✅' : '⬜'} ${g.name} (${g.memberCount})`,
          `bc:gtog:${g.id}`,
        )
        .row(),
    );
    kb.text(
      peopleCount ? `👤 People (${peopleCount} selected)` : '👤 Add specific people',
      'bc:people',
    ).row();
    if (this.hasTargets(b ?? {})) kb.text('▶️ Continue', 'bc:go').row();
    kb.text('✖ Cancel', 'menu:home');
    await this.render(
      ctx,
      `<b>📣 Broadcast</b>\nPick groups and/or people ` +
        `(${selected.size} group${selected.size === 1 ? '' : 's'}, ${peopleCount} ` +
        `${peopleCount === 1 ? 'person' : 'people'}):`,
      kb,
      true,
    );
  }

  /** Multi-select individual subscribers to add to the broadcast (paginated). */
  private async renderSubscriberSelect(
    ctx: Context,
    p: AuthPrincipal,
    page: number,
  ): Promise<void> {
    const session = getSession(ctx.from!.id);
    const selected = new Set(session.broadcast?.subscriberIds ?? []);
    const all = await this.subscribers.list(p.sourceId);
    const { slice, pg, pages } = this.paginate(all, page);
    const kb = new InlineKeyboard();
    slice.forEach((s) => {
      const label = s.username ? `@${s.username}` : s.telegramUserId;
      kb.text(
        `${selected.has(s.id) ? '✅' : '⬜'} ${label}`,
        `bc:stog:${s.id}:${pg}`,
      ).row();
    });
    this.navRow(kb, 'bc:people:', pg, pages);
    kb.text('⬅️ Back to groups', 'bc:groups').row();
    kb.text('✖ Cancel', 'menu:home');
    const body = all.length
      ? `<b>👤 Add people</b>\nTap to include (${selected.size} selected):`
      : '<b>👤 Add people</b>\n\n📭 No subscribers yet — share an invite link first.';
    await this.render(ctx, body, kb, true);
  }

  private async showConfirm(ctx: Context, p: AuthPrincipal): Promise<void> {
    const session = getSession(ctx.from!.id);
    const b = session.broadcast!;
    const n = await this.notifications.get(p.sourceId, b.notificationId!);
    const groupNames = (await this.groups.list(p.sourceId))
      .filter((g) => (b.groupIds ?? []).includes(g.id))
      .map((g) => g.name);
    const peopleCount = b.subscriberIds?.length ?? 0;
    const parts = [
      ...groupNames,
      ...(peopleCount ? [`${peopleCount} ${peopleCount === 1 ? 'person' : 'people'}`] : []),
    ];
    const kb = new InlineKeyboard()
      .text('✅ Send now', 'bc:send')
      .text('✖ Cancel', 'menu:home');
    await this.render(
      ctx,
      `📣 Send <b>${esc(n.name)}</b> to: ${esc(parts.join(', '))}?`,
      kb,
      true,
    );
  }

  /** Send a broadcast with no placeholders (the placeholder path uses bcFill). */
  private async doSend(ctx: Context, p: AuthPrincipal): Promise<void> {
    const session = getSession(ctx.from!.id);
    const b = session.broadcast!;
    const view = await this.broadcasts.create(
      p.sourceId,
      {
        notificationId: b.notificationId!,
        groupIds: b.groupIds ?? [],
        subscriberIds: b.subscriberIds ?? [],
        placeholderValues: {},
        interaction: b.interaction,
        sendKey: `bot-${ctx.from!.id}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      },
      `telegram:${ctx.from!.id}`,
    );
    clearSession(ctx.from!.id);
    const kb = new InlineKeyboard().text('🏠 Menu', 'menu:home');
    await this.render(ctx, this.sentSummary(view.totalCount, (b.groupIds ?? []).length), kb, true);
  }

  // ── Free-text fallback ──────────────────────────────────────────────────────

  private async onText(ctx: Context): Promise<void> {
    const text = ctx.message?.text ?? '';
    if (text.startsWith('/')) return; // commands handled elsewhere
    // Owner's stray message opens the menu; requireOwner handles the non-owner
    // reply (reader card for subscribers, connect prompt for strangers).
    const principal = await this.requireOwner(ctx);
    if (!principal) return;
    await this.openHome(ctx, false);
  }

  /**
   * Shared "you're a reader" copy for consumers — no admin commands. Public so
   * {@link BotRunner} can reuse it for the `/start` welcome and keep the wording
   * identical to what this menu shows on stray input / help.
   */
  consumerMessage(sourceNames: string[]): string {
    const where = sourceNames.length
      ? ` to <b>${sourceNames.map(esc).join(', ')}</b>`
      : '';
    return (
      `📬 <b>You're subscribed${where}.</b>\n\n` +
      `Updates arrive right here — there's nothing to manage and no commands to run. ` +
      `When a message asks for a response, just tap its buttons.\n\n` +
      `Send /stop anytime to unsubscribe.`
    );
  }

  /** Reply to a non-owner: reader card if subscribed, else a connect prompt. */
  private async replyNonOwner(ctx: Context, tgId: bigint): Promise<void> {
    const subs = await this.subscribers.activeSubscriptionsByTelegramId(tgId);
    if (subs.length) {
      await ctx.reply(this.consumerMessage(subs.map((s) => s.sourceName)), {
        parse_mode: 'HTML',
      });
      return;
    }
    await ctx.reply(
      "👋 You're not connected yet. Open a workspace invite or start link to begin.",
    );
  }

  // ── Conversations (guided multi-step input) ────────────────────────────────

  /** Install the conversations engine + builders. Call BEFORE other handlers so
   *  an active conversation captures input ahead of the command/callback routes. */
  installConversations(bot: Bot): void {
    bot.use(conversations() as never);
    bot.use(createConversation(this.createNotifConvo as never, 'createNotif') as never);
    bot.use(createConversation(this.editNotifConvo as never, 'editNotif') as never);
    bot.use(createConversation(this.createGroupConvo as never, 'createGroup') as never);
    bot.use(createConversation(this.bcFillConvo as never, 'bcFill') as never);
    bot.use(createConversation(this.composeBroadcastMsgConvo as never, 'composeBroadcastMsg') as never);
    bot.use(createConversation(this.adjustBroadcastMsgConvo as never, 'adjustBroadcastMsg') as never);
    bot.use(createConversation(this.scheduleBroadcastConvo as never, 'scheduleBroadcast') as never);
    bot.use(createConversation(this.pollSetupConvo as never, 'pollSetup') as never);
    bot.use(createConversation(this.answerQuestionConvo as never, 'answerQuestion') as never);
  }

  /** Guided notification authoring: name → body, Cancel at every step. */
  private createNotifConvo = async (conversation: Conv, ctx: Context): Promise<void> => {
    const cancel = new InlineKeyboard().text('✖ Cancel', 'convo:cancel');
    await ctx.reply('📝 <b>New notification</b> (step 1/2)\nSend a name:', {
      parse_mode: 'HTML',
      reply_markup: cancel,
    });
    let name = '';
    for (;;) {
      const u = await conversation.wait();
      if (this.isCancel(u)) return this.cancelled(ctx, u);
      const t = (u.message?.text ?? '').trim();
      if (!t) {
        await ctx.reply('Please send a name as text, or ✖ Cancel.', { reply_markup: cancel });
        continue;
      }
      if (t.length > 160) {
        await ctx.reply('That name is too long (max 160). Try again.', { reply_markup: cancel });
        continue;
      }
      name = t;
      break;
    }
    await ctx.reply(
      `📝 <b>New notification</b> (step 2/2)\n<i>Name:</i> ${esc(name)}\n\n` +
        'Send the message body. Use {placeholders} like {name} to personalize.',
      { parse_mode: 'HTML', reply_markup: cancel },
    );
    let body = '';
    for (;;) {
      const u = await conversation.wait();
      if (this.isCancel(u)) return this.cancelled(ctx, u);
      const t = u.message?.text;
      if (!t) {
        await ctx.reply('Please send the body as text, or ✖ Cancel.', { reply_markup: cancel });
        continue;
      }
      body = t;
      break;
    }
    const sourceId = await conversation.external(() => this.ownerSourceId(ctx));
    if (!sourceId) return void (await ctx.reply('You are not connected to a workspace.'));
    try {
      const n = await conversation.external(() =>
        this.notifications.create(sourceId, { name, body }),
      );
      const ph = n.placeholders.length
        ? `\n<i>Placeholders:</i> ${esc(n.placeholders.map((x) => `{${x}}`).join(', '))}`
        : '';
      await ctx.reply(`✅ Created <b>${esc(n.name)}</b>.${ph}`, {
        parse_mode: 'HTML',
        reply_markup: this.homeKeyboard(),
      });
    } catch (err) {
      await ctx.reply(`⚠️ ${esc(humanError(err))}`, {
        parse_mode: 'HTML',
        reply_markup: this.homeKeyboard(),
      });
    }
  };

  /** Guided edit: name → body, each with a "Keep current" option. */
  private editNotifConvo = async (
    conversation: Conv,
    ctx: Context,
    notifId: string,
  ): Promise<void> => {
    const kb = new InlineKeyboard()
      .text('↩️ Keep current', 'convo:keep')
      .text('✖ Cancel', 'convo:cancel');
    const sourceId = await conversation.external(() => this.ownerSourceId(ctx));
    if (!sourceId) return void (await ctx.reply('You are not connected to a workspace.'));
    let current: { name: string; body: string };
    try {
      current = await conversation.external(() => this.notifications.get(sourceId, notifId));
    } catch {
      return void (await ctx.reply('That notification no longer exists.'));
    }

    await ctx.reply(
      `✏️ <b>Edit</b> — send a new name, or keep it.\n<i>Current:</i> ${esc(current.name)}`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
    let name = current.name;
    for (;;) {
      const u = await conversation.wait();
      if (u.callbackQuery?.data === 'convo:keep') {
        await u.answerCallbackQuery().catch(() => undefined);
        break;
      }
      if (this.isCancel(u)) return this.cancelled(ctx, u);
      const t = (u.message?.text ?? '').trim();
      if (!t) {
        await ctx.reply('Send a name, or ↩️ Keep / ✖ Cancel.', { reply_markup: kb });
        continue;
      }
      name = t;
      break;
    }

    await ctx.reply(
      `✏️ Send a new body, or keep it. Use {placeholders} like {name}.\n<i>Current:</i>\n${esc(current.body)}`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
    let body = current.body;
    for (;;) {
      const u = await conversation.wait();
      if (u.callbackQuery?.data === 'convo:keep') {
        await u.answerCallbackQuery().catch(() => undefined);
        break;
      }
      if (this.isCancel(u)) return this.cancelled(ctx, u);
      const t = u.message?.text;
      if (!t) {
        await ctx.reply('Send a body, or ↩️ Keep / ✖ Cancel.', { reply_markup: kb });
        continue;
      }
      body = t;
      break;
    }

    try {
      const n = await conversation.external(() =>
        this.notifications.update(sourceId, notifId, { name, body }),
      );
      const ph = n.placeholders.length
        ? `\n<i>Placeholders:</i> ${esc(n.placeholders.map((x) => `{${x}}`).join(', '))}`
        : '';
      await ctx.reply(`✅ Updated <b>${esc(n.name)}</b>.${ph}`, {
        parse_mode: 'HTML',
        reply_markup: this.homeKeyboard(),
      });
    } catch (err) {
      await ctx.reply(`⚠️ ${esc(humanError(err))}`, {
        parse_mode: 'HTML',
        reply_markup: this.homeKeyboard(),
      });
    }
  };

  /** Guided group creation: one name, retry-on-conflict, Cancel anytime. */
  private createGroupConvo = async (conversation: Conv, ctx: Context): Promise<void> => {
    const cancel = new InlineKeyboard().text('✖ Cancel', 'convo:cancel');
    await ctx.reply('👥 <b>New group</b>\nSend a name:', {
      parse_mode: 'HTML',
      reply_markup: cancel,
    });
    for (;;) {
      const u = await conversation.wait();
      if (this.isCancel(u)) return this.cancelled(ctx, u);
      const t = (u.message?.text ?? '').trim();
      if (!t) {
        await ctx.reply('Please send a name, or ✖ Cancel.', { reply_markup: cancel });
        continue;
      }
      const sourceId = await conversation.external(() => this.ownerSourceId(ctx));
      if (!sourceId) return void (await ctx.reply('You are not connected to a workspace.'));
      try {
        await conversation.external(() => this.groups.create(sourceId, t));
        await ctx.reply(`✅ Group <b>${esc(t)}</b> created.`, {
          parse_mode: 'HTML',
          reply_markup: this.homeKeyboard(),
        });
        return;
      } catch (err) {
        await ctx.reply(`⚠️ ${esc(humanError(err))}\nTry another name, or ✖ Cancel.`, {
          parse_mode: 'HTML',
          reply_markup: cancel,
        });
      }
    }
  };

  /** Guided placeholder fill (one prompt per placeholder), then send. */
  private bcFillConvo = async (
    conversation: Conv,
    ctx: Context,
    notifId: string,
    groupCsv: string,
    subCsv = '',
    interactionJson = 'null',
  ): Promise<void> => {
    const cancel = new InlineKeyboard().text('✖ Cancel', 'convo:cancel');
    const sourceId = await conversation.external(() => this.ownerSourceId(ctx));
    if (!sourceId) return void (await ctx.reply('You are not connected to a workspace.'));
    const n = await conversation.external(() => this.notifications.get(sourceId, notifId));
    const values: Record<string, string> = {};
    for (const ph of n.placeholders) {
      await ctx.reply(`✏️ Value for <b>{${esc(ph)}}</b>:`, {
        parse_mode: 'HTML',
        reply_markup: cancel,
      });
      for (;;) {
        const u = await conversation.wait();
        if (this.isCancel(u)) return this.cancelled(ctx, u);
        const t = u.message?.text;
        if (t === undefined || t === '') {
          await ctx.reply('Please send a value, or ✖ Cancel.', { reply_markup: cancel });
          continue;
        }
        values[ph] = t;
        break;
      }
    }
    const groupIds = groupCsv.split(',').filter(Boolean);
    const subscriberIds = subCsv.split(',').filter(Boolean);
    const interaction =
      (JSON.parse(interactionJson) as
        | { type: 'poll' | 'question'; options: string[] }
        | null) ?? undefined;
    try {
      const view = await conversation.external(() =>
        this.broadcasts.create(
          sourceId,
          {
            notificationId: notifId,
            groupIds,
            subscriberIds,
            placeholderValues: values,
            interaction,
            sendKey: `bot-${ctx.from?.id}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          },
          `telegram:${ctx.from?.id}`,
        ),
      );
      await ctx.reply(this.sentSummary(view.totalCount, groupIds.length), {
        parse_mode: 'HTML',
        reply_markup: this.homeKeyboard(),
      });
    } catch (err) {
      await ctx.reply(`⚠️ ${esc(humanError(err))}`, {
        parse_mode: 'HTML',
        reply_markup: this.homeKeyboard(),
      });
    }
  };

  /**
   * Compose a brand-new message inside the broadcast flow. The owner types the
   * body, then chooses to save it as a reusable template or send it just this
   * once — either way it becomes the broadcast's message.
   */
  private composeBroadcastMsgConvo = async (
    conversation: Conv,
    ctx: Context,
  ): Promise<void> => {
    const cancel = new InlineKeyboard().text('✖ Cancel', 'convo:cancel');
    await ctx.reply(
      '✍️ <b>New message</b>\nSend the text to broadcast. Use {placeholders} like ' +
        '{name} to personalize.',
      { parse_mode: 'HTML', reply_markup: cancel },
    );
    let body = '';
    for (;;) {
      const u = await conversation.wait();
      if (this.isCancel(u)) return this.cancelled(ctx, u);
      const t = u.message?.text;
      if (!t || !t.trim()) {
        await ctx.reply('Please send the message as text, or ✖ Cancel.', {
          reply_markup: cancel,
        });
        continue;
      }
      body = t;
      break;
    }
    await this.finishComposed(conversation, ctx, body, 'Save to gallery');
  };

  /**
   * Take a saved template as a base and write something on top for this send.
   * The added text goes above the base body; the result can be saved as a new
   * template or sent once, leaving the original untouched.
   */
  private adjustBroadcastMsgConvo = async (
    conversation: Conv,
    ctx: Context,
    baseId: string,
  ): Promise<void> => {
    const cancel = new InlineKeyboard().text('✖ Cancel', 'convo:cancel');
    const sourceId = await conversation.external(() => this.ownerSourceId(ctx));
    if (!sourceId) return void (await ctx.reply('You are not connected to a workspace.'));
    let base: NotificationView;
    try {
      base = await conversation.external(() => this.notifications.get(sourceId, baseId));
    } catch {
      return void (await ctx.reply('That message no longer exists.', {
        reply_markup: this.homeKeyboard(),
      }));
    }
    const preview = base.body.length > 500 ? `${base.body.slice(0, 500)}…` : base.body;
    await ctx.reply(
      `✏️ <b>Add text on top of</b> “${esc(base.name)}”.\n\n` +
        `<i>Base message:</i>\n${esc(preview)}\n\n` +
        'Send the text to add — it will appear <b>above</b> the base.',
      { parse_mode: 'HTML', reply_markup: cancel },
    );
    let extra = '';
    for (;;) {
      const u = await conversation.wait();
      if (this.isCancel(u)) return this.cancelled(ctx, u);
      const t = u.message?.text;
      if (!t || !t.trim()) {
        await ctx.reply('Please send the text to add, or ✖ Cancel.', { reply_markup: cancel });
        continue;
      }
      extra = t;
      break;
    }
    const combined = `${extra}\n\n${base.body}`;
    await this.finishComposed(
      conversation,
      ctx,
      combined,
      'Save as template',
      `${base.name} (edited)`,
    );
  };

  /**
   * Shared tail for the compose/adjust flows: ask one-time vs saved, create the
   * (possibly ephemeral) notification, stash it on the session, then hand off to
   * the recipient picker via a button — so nav stays edit-in-place from there.
   */
  private finishComposed = async (
    conversation: Conv,
    ctx: Context,
    body: string,
    saveVerb: string,
    name?: string,
  ): Promise<void> => {
    const sourceId = await conversation.external(() => this.ownerSourceId(ctx));
    if (!sourceId) return void (await ctx.reply('You are not connected to a workspace.'));

    const modeKb = new InlineKeyboard()
      .text('1️⃣ Just this once', 'convo:save:once')
      .text(`💾 ${saveVerb}`, 'convo:save:keep')
      .row()
      .text('✖ Cancel', 'convo:cancel');
    // Show the final message (the merged result, for the adjust flow) so the owner
    // sees exactly what will go out before choosing how to keep it.
    const preview = body.length > 600 ? `${body.slice(0, 600)}…` : body;
    await ctx.reply(
      `📄 <b>Your message</b>\n\n${esc(preview)}\n\n` +
        '💾 <b>Keep this message?</b>\n<i>Save it to reuse later, or send it just this once.</i>',
      { parse_mode: 'HTML', reply_markup: modeKb },
    );
    let ephemeral = true;
    for (;;) {
      const u = await conversation.wait();
      const d = u.callbackQuery?.data;
      if (d === 'convo:save:once' || d === 'convo:save:keep') {
        await u.answerCallbackQuery().catch(() => undefined);
        ephemeral = d === 'convo:save:once';
        break;
      }
      if (this.isCancel(u)) return this.cancelled(ctx, u);
      await ctx.reply(`Tap “Just this once” or “${saveVerb}”.`, { reply_markup: modeKb });
    }

    let created: NotificationView;
    try {
      created = await conversation.external(() =>
        this.notifications.createInline(sourceId, { body, name, ephemeral }),
      );
    } catch (err) {
      return void (await ctx.reply(`⚠️ ${esc(humanError(err))}`, {
        parse_mode: 'HTML',
        reply_markup: this.homeKeyboard(),
      }));
    }

    await conversation.external(() => {
      const s = getSession(ctx.from!.id);
      s.broadcast = { notificationId: created.id, groupIds: [], subscriberIds: [] };
    });

    const note = ephemeral
      ? '<i>One-time message — not saved to your gallery.</i>'
      : `<i>Saved as “${esc(created.name)}”.</i>`;
    const ph = created.placeholders.length
      ? `\n<i>You'll fill ${esc(created.placeholders.map((x) => `{${x}}`).join(', '))} before it sends.</i>`
      : '';
    const kb = new InlineKeyboard()
      .text('▶️ Choose recipients', 'bc:groups')
      .row()
      .text('✖ Cancel', 'menu:home');
    await ctx.reply(`✅ Ready. ${note}${ph}\n\nNow pick who gets it.`, {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  };

  /** Owner sets up a poll: collect 2–4 options, stash on the session, then send. */
  private pollSetupConvo = async (
    conversation: Conv,
    ctx: Context,
  ): Promise<void> => {
    const cancel = new InlineKeyboard().text('✖ Cancel', 'convo:cancel');
    await ctx.reply(
      '📊 <b>Poll options</b>\nSend 2–4 options — one per line (or comma-separated).',
      { parse_mode: 'HTML', reply_markup: cancel },
    );
    let options: string[] = [];
    for (;;) {
      const u = await conversation.wait();
      if (this.isCancel(u)) return this.cancelled(ctx, u);
      options = (u.message?.text ?? '')
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (options.length < 2 || options.length > 4) {
        await ctx.reply('Please send between 2 and 4 options.', { reply_markup: cancel });
        continue;
      }
      if (options.some((o) => o.length > 64)) {
        await ctx.reply('Each option must be 64 characters or fewer.', { reply_markup: cancel });
        continue;
      }
      break;
    }
    await conversation.external(() => {
      const s = getSession(ctx.from!.id);
      s.broadcast = { ...s.broadcast, interaction: { type: 'poll', options } };
    });
    const kb = new InlineKeyboard()
      .text('✅ Send now', 'bc:now')
      .row()
      .text('✖ Cancel', 'menu:home');
    await ctx.reply(
      `📊 Poll ready: <i>${options.map(esc).join(' · ')}</i>\nSend now?`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
  };

  /** A subscriber taps “Answer” → capture one free-text reply and record it. */
  private answerQuestionConvo = async (
    conversation: Conv,
    ctx: Context,
    broadcastId: string,
  ): Promise<void> => {
    const cancel = new InlineKeyboard().text('✖ Cancel', 'convo:cancel');
    await ctx.reply('✍️ Type your answer:', { reply_markup: cancel });
    let answer = '';
    for (;;) {
      const u = await conversation.wait();
      // Subscriber-facing: a plain cancel (no owner menu).
      if (u.callbackQuery || (u.message?.text ?? '').startsWith('/')) {
        if (u.callbackQuery) await u.answerCallbackQuery().catch(() => undefined);
        return void (await ctx.reply('✖ Cancelled.'));
      }
      const t = u.message?.text;
      if (!t || !t.trim()) {
        await ctx.reply('Please send your answer as text, or ✖ Cancel.', { reply_markup: cancel });
        continue;
      }
      answer = t;
      break;
    }
    const tgId = ctx.from!.id;
    try {
      await conversation.external(() =>
        this.responses.recordText(broadcastId, tgId, answer),
      );
      await ctx.reply('✅ Sent — thanks!');
    } catch (err) {
      await ctx.reply(`⚠️ ${esc(humanError(err))}`);
    }
  };

  /** Guided scheduling: when → repeat → placeholders → schedule. */
  private scheduleBroadcastConvo = async (
    conversation: Conv,
    ctx: Context,
    notifId: string,
    groupCsv: string,
  ): Promise<void> => {
    const cancel = new InlineKeyboard().text('✖ Cancel', 'convo:cancel');
    const sourceId = await conversation.external(() => this.ownerSourceId(ctx));
    if (!sourceId) return void (await ctx.reply('You are not connected to a workspace.'));
    const n = await conversation.external(() => this.notifications.get(sourceId, notifId));

    // 1) When
    await ctx.reply(
      '⏰ <b>When?</b>\nReply with <code>+30m</code>, <code>+2h</code>, <code>+1d</code>, ' +
        'or a UTC time like <code>2026-07-05 14:30</code>.',
      { parse_mode: 'HTML', reply_markup: cancel },
    );
    let sendAt: Date;
    for (;;) {
      const u = await conversation.wait();
      if (this.isCancel(u)) return this.cancelled(ctx, u);
      const parsed = this.parseWhen(u.message?.text ?? '');
      if (!parsed) {
        await ctx.reply('Couldn’t read that. Try +2h, +30m, +1d, or 2026-07-05 14:30 (UTC).', { reply_markup: cancel });
        continue;
      }
      if (parsed.getTime() <= Date.now()) {
        await ctx.reply('That time is in the past — pick a future time.', { reply_markup: cancel });
        continue;
      }
      sendAt = parsed;
      break;
    }

    // 2) Repeat
    const repKb = new InlineKeyboard()
      .text('Once', 'convo:rep:none')
      .text('Daily', 'convo:rep:daily')
      .text('Weekly', 'convo:rep:weekly')
      .row()
      .text('✖ Cancel', 'convo:cancel');
    await ctx.reply('🔁 Repeat?', { reply_markup: repKb });
    let repeat: 'none' | 'daily' | 'weekly' = 'none';
    for (;;) {
      const u = await conversation.wait();
      const d = u.callbackQuery?.data;
      if (d && d.startsWith('convo:rep:')) {
        await u.answerCallbackQuery().catch(() => undefined);
        repeat = d.slice('convo:rep:'.length) as 'none' | 'daily' | 'weekly';
        break;
      }
      if (this.isCancel(u)) return this.cancelled(ctx, u);
      await ctx.reply('Tap Once, Daily, or Weekly.', { reply_markup: repKb });
    }

    // 3) Placeholders (if any)
    const values: Record<string, string> = {};
    for (const ph of n.placeholders) {
      await ctx.reply(`✏️ Value for <b>{${esc(ph)}}</b>:`, { parse_mode: 'HTML', reply_markup: cancel });
      for (;;) {
        const u = await conversation.wait();
        if (this.isCancel(u)) return this.cancelled(ctx, u);
        const t = u.message?.text;
        if (t === undefined || t === '') {
          await ctx.reply('Send a value, or ✖ Cancel.', { reply_markup: cancel });
          continue;
        }
        values[ph] = t;
        break;
      }
    }

    // 4) Create
    const groupIds = groupCsv.split(',').filter(Boolean);
    try {
      const v = await conversation.external(() =>
        this.schedule.schedule(
          sourceId,
          { notificationId: notifId, groupIds, placeholderValues: values, sendAt: sendAt.toISOString(), repeat },
          `telegram:${ctx.from?.id}`,
        ),
      );
      const rep = repeat === 'none' ? 'once' : repeat;
      await ctx.reply(`⏰ <b>Scheduled</b> for ${this.formatWhen(v.sendAt)} UTC (${rep}).`, {
        parse_mode: 'HTML',
        reply_markup: this.homeKeyboard(),
      });
    } catch (err) {
      await ctx.reply(`⚠️ ${esc(humanError(err))}`, { parse_mode: 'HTML', reply_markup: this.homeKeyboard() });
    }
  };

  /** Parse "+30m" / "+2h" / "+1d" or "YYYY-MM-DD HH:MM" (UTC) → Date, or null. */
  private parseWhen(text: string): Date | null {
    const t = text.trim();
    const rel = t.match(/^\+(\d+)\s*([mhd])$/i);
    if (rel) {
      const n = parseInt(rel[1], 10);
      const unit = rel[2].toLowerCase();
      const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
      return new Date(Date.now() + n * ms);
    }
    const abs = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
    if (abs) {
      const ms = Date.UTC(+abs[1], +abs[2] - 1, +abs[3], +abs[4], +abs[5]);
      return Number.isNaN(ms) ? null : new Date(ms);
    }
    return null;
  }

  /** Any button tap or command during a conversation cancels it. */
  private isCancel(u: Context): boolean {
    return !!u.callbackQuery || !!u.message?.text?.startsWith('/');
  }

  private async cancelled(ctx: Context, u: Context): Promise<void> {
    if (u.callbackQuery) await u.answerCallbackQuery().catch(() => undefined);
    await ctx.reply('✖ Cancelled.', { reply_markup: this.homeKeyboard() });
  }

  private async ownerSourceId(ctx: Context): Promise<string | null> {
    if (!ctx.from) return null;
    const p = await this.sources.resolveByTelegramId(BigInt(ctx.from.id));
    return p?.sourceId ?? null;
  }

  private homeKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text('📝 Notifications', 'notif:list')
      .text('👥 Groups', 'grp:list')
      .row()
      .text('🔗 Invite links', 'inv:list')
      .text('📣 Broadcast', 'bc:start')
      .row()
      .text('👤 Subscribers', 'sub:list')
      .text('⏰ Scheduled', 'sch:list')
      .row()
      .text('📥 Responses', 'res:list');
  }

  private sentSummary(recipients: number, groupCount: number): string {
    if (recipients === 0) {
      return '📭 No active recipients — nothing was sent.';
    }
    const people = recipients === 1 ? '1 person' : `${recipients} people`;
    if (groupCount === 0) return `✅ <b>On its way</b> to ${people}.`;
    const groups = groupCount === 1 ? '1 group' : `${groupCount} groups`;
    return `✅ <b>On its way</b> to ${people} (${groups}).`;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async requireOwner(ctx: Context): Promise<AuthPrincipal | null> {
    if (!ctx.from) return null;
    const tgId = BigInt(ctx.from.id);
    const principal = await this.sources.resolveByTelegramId(tgId);
    if (!principal) {
      // Not an owner: a subscriber gets the reader card, a stranger the connect
      // prompt — never the misleading "not connected" when they ARE subscribed.
      await this.replyNonOwner(ctx, tgId).catch(() => undefined);
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
