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
import { profileName } from '@paedavic/telegram';
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
    { command: 'write', description: 'Write & send a message', run: (c) => this.openWrite(c) },
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
    // Wrapped so a thrown error replies to the owner instead of vanishing into
    // bot.catch (which only logs) and leaving the tap with no feedback.
    for (const c of this.menuCommandDefs) {
      bot.command(c.command, (ctx) => this.runCommand(ctx, c.run));
    }
    // Callbacks + free-text must come after commands so commands win.
    bot.on('callback_query:data', (ctx) => this.onCallback(ctx));
    bot.on('message:text', (ctx) => this.onText(ctx));
  }

  /** Run a slash-command handler, surfacing any failure as a friendly reply. */
  private async runCommand(
    ctx: Context,
    run: (ctx: Context) => Promise<void>,
  ): Promise<void> {
    try {
      await run(ctx);
    } catch (err) {
      this.logger.error(`command failed: ${(err as Error).message}`);
      await ctx.reply(`⚠️ ${esc(humanError(err))}`, { parse_mode: 'HTML' }).catch(() => undefined);
    }
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

  /** /write → jump straight into composing a free-form message (no template). */
  private async openWrite(ctx: Context): Promise<void> {
    const p = await this.requireOwner(ctx);
    if (!p) return;
    await this.bc(ctx, p, 'new', '');
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
        '✍️ /write — write &amp; send a message, no template needed',
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
    // Landing on home is a fresh start — drop any half-built broadcast draft so a
    // stale target/message can't resurrect into a later compose ("✖ Cancel" → home
    // leads here, which is how an abandoned draft gets discarded).
    if (ctx.from) getSession(ctx.from.id).broadcast = undefined;
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

    // "Change my name" on the reader card / join message — subscriber
    // self-service, so it must also run before the owner gate.
    if (ns === 'self' && action === 'ren') {
      await ctx.answerCallbackQuery().catch(() => undefined);
      return void (await this.enterConvo(ctx, 'renameSelf'));
    }

    const principal = await this.requireOwner(ctx);
    if (!principal) {
      await ctx.answerCallbackQuery().catch(() => undefined); // just clear the spinner
      return;
    }

    // Telegram allows exactly ONE answer per callback query, so the spinner is
    // acked AFTER the action: success clears it quietly, failure turns it into
    // a visible alert. (Acking first would make every error alert a no-op.)
    try {
      if (ns === 'menu') await this.openHome(ctx, true);
      else if (ns === 'notif') await this.notif(ctx, principal, action, arg);
      else if (ns === 'grp') await this.grp(ctx, principal, action, arg);
      else if (ns === 'inv') await this.inv(ctx, principal, action, arg);
      else if (ns === 'bc') await this.bc(ctx, principal, action, arg);
      else if (ns === 'sch') await this.sch(ctx, principal, action, arg);
      else if (ns === 'sub') await this.sub(ctx, principal, action, arg);
      else if (ns === 'res') await this.res(ctx, principal, action, arg);
      // 'noop' (pagination label) and unknown namespaces fall through to the ack.
      await ctx.answerCallbackQuery().catch(() => undefined);
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
    // Opportunistic identity backfill: a tap gives us fresh profile data for
    // subscribers who joined before names were captured. Fire-and-forget.
    void this.subscribers
      .refreshIdentity(BigInt(tgId), ctx.from?.username, profileName(ctx.from))
      .catch(() => undefined);
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
      kb.text(
        `${memberIds.has(s.id) ? '✅' : '⬜'} ${s.displayName}`,
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
      // Each row answers "which audience is this?" at a glance: the bound
      // group's name (or "Anyone"), then the join count.
      slice.forEach((l) => {
        const joins = `${l.joinCount} ${l.joinCount === 1 ? 'join' : 'joins'}`;
        const gone = l.active ? '' : ' · revoked';
        kb.text(
          `${l.active ? '🔗' : '🚫'} ${l.groupName ?? 'Anyone'} · ${joins}${gone}`,
          `inv:view:${l.id}`,
        ).row();
      });
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
      const audience = l.groupName
        ? `Joiners are added to <b>${esc(l.groupName)}</b>`
        : 'Open to anyone (no group)';
      await this.render(
        ctx,
        this.flash(flash) +
          `<b>🔗 Invite link</b> (${status})\n` +
          `${audience}\nJoins: ${l.joinCount}\n\n<code>${esc(l.url)}</code>`,
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

  /** bc:* actions that operate on an in-flight draft (vs. starting/seeding one).
   *  In every designed path the draft has a notificationId by the time these
   *  buttons appear — so its absence means the draft is gone. */
  private static readonly BC_DRAFT_ACTIONS = new Set([
    'gtog', 'stog', 'people', 'groups', 'go', 'react', 'now', 'sched', 'send',
  ]);

  private async bc(
    ctx: Context,
    p: AuthPrincipal,
    action: string,
    arg: string,
  ): Promise<void> {
    const session = getSession(ctx.from!.id);
    // Stale-button guard: after a restart (in-memory sessions wiped) or once a
    // send completed (session cleared), old buttons must degrade to a restart
    // card — not crash on an undefined draft (bc:now / bc:send) and not loop
    // the picker silently (bc:go with no message chosen).
    if (
      AdminMenu.BC_DRAFT_ACTIONS.has(action) &&
      !session.broadcast?.notificationId
    ) {
      return this.renderExpiredFlow(ctx);
    }
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
      // rewrite it (for this send only, or permanently), or write something on
      // top for this send only.
      const n = await this.notifications.get(p.sourceId, arg);
      const kb = new InlineKeyboard()
        .text('➡️ Use as is', `bc:use:${n.id}`)
        .row()
        .text('✏️ Edit message', `bc:edit:${n.id}`)
        .row()
        .text('➕ Add text on top', `bc:adjust:${n.id}`)
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
      // Fresh free-form message (also the home-menu "Quick message" entry and
      // /write) — reset any leftover selection so a stale target from an
      // abandoned flow can't leak into this send.
      session.broadcast = { groupIds: [], subscriberIds: [] };
      await this.enterConvo(ctx, 'composeBroadcastMsg');
      return;
    }
    if (action === 'adjust') {
      await this.enterConvo(ctx, 'adjustBroadcastMsg', arg);
      return;
    }
    if (action === 'edit') {
      await this.enterConvo(ctx, 'editBroadcastMsg', arg);
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
        kb.text(`👤 ${s.displayName}`, `sub:view:${s.id}`).row();
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
      const kb = new InlineKeyboard()
        .text('📨 Send message', `sub:send:${s.id}`)
        .row()
        .text('📜 History', `sub:hist:${s.id}`)
        .text('✏️ Rename', `sub:ren:${s.id}`)
        .row()
        .text('➿ Move to group', `sub:move:${s.id}`)
        .row()
        .text('🚫 Unsubscribe', `sub:unsub:${s.id}`)
        .row()
        .text('⬅️ Back', 'sub:list');
      // Identity facets under the display name — so the owner still knows who
      // this is after any rename: the name they chose for themselves and their
      // Telegram name (when hidden by an override), @username, and the raw id.
      const facts: string[] = [];
      if (s.selfName && s.selfName !== s.displayName) facts.push(esc(s.selfName));
      if (s.name && s.name !== s.displayName) facts.push(esc(s.name));
      if (s.username) facts.push(`@${esc(s.username)}`);
      facts.push(`<code>${s.telegramUserId}</code>`);
      await this.render(
        ctx,
        this.flash(flash) +
          `<b>👤 ${esc(s.displayName)}</b>\n${facts.join(' · ')}\n` +
          `Status: ${s.status} · joined ${this.formatWhen(s.joinedAt)} UTC`,
        kb,
        true,
      );
      return;
    }

    if (action === 'ren') {
      await this.enterConvo(ctx, 'renameSubscriber', arg);
      return;
    }

    if (action === 'hist') {
      // arg is "subscriberId" or "subscriberId:page". Per-person delivery log —
      // every message they got (or missed), group sends included.
      const [subId, pageStr] = arg.split(':');
      const page = parseInt(pageStr || '0', 10) || 0;
      const [s, entries] = await Promise.all([
        this.subscribers
          .list(p.sourceId)
          .then((all) => all.find((x) => x.id === subId)),
        this.subscribers.history(p.sourceId, subId),
      ]);
      const { slice, pg, pages } = this.paginate(entries, page);
      const icons = { sent: '✅', blocked: '🚫', failed: '⚠️', queued: '⏳' } as const;
      const lines = slice.map((e) => {
        const note =
          e.status === 'sent'
            ? ''
            : e.status === 'blocked'
              ? ' (blocked the bot)'
              : e.status === 'queued'
                ? ' (sending…)'
                : e.error?.includes('unsubscribed')
                  ? ' (unsubscribed)'
                  : ' (failed)';
        return `${icons[e.status]} ${this.formatWhen(e.when)} · ${esc(e.notificationName)}${note}`;
      });
      const kb = new InlineKeyboard();
      this.navRow(kb, `sub:hist:${subId}:`, pg, pages);
      kb.text('⬅️ Back', `sub:view:${subId}`);
      const who = s ? esc(s.displayName) : 'subscriber';
      await this.render(
        ctx,
        `<b>📜 History — ${who}</b> · ${entries.length}\n\n` +
          (lines.join('\n') || '📭 Nothing has been sent to them yet.'),
        kb,
        true,
      );
      return;
    }

    if (action === 'send') {
      // Fresh single-recipient broadcast: pick a saved message or write one.
      // The header names the recipient so the owner never loses track of who
      // this message is for, even after a compose/edit detour.
      session.broadcast = { subscriberIds: [arg], groupIds: [] };
      const [items, who] = await Promise.all([
        this.notifications.list(p.sourceId),
        this.subscribers
          .list(p.sourceId)
          .then((all) => all.find((x) => x.id === arg)),
      ]);
      const kb = new InlineKeyboard();
      items.forEach((n) => kb.text(`📝 ${n.name}`, `sub:pick:${arg}:${n.id}`).row());
      kb.text('✍️ Write a new message', `sub:new:${arg}`).row();
      kb.text('⬅️ Back', `sub:view:${arg}`);
      const header = `<b>📨 Message to ${esc(who?.displayName ?? 'subscriber')}</b>`;
      await this.render(
        ctx,
        items.length
          ? `${header}\nPick a saved message, or write a new one:`
          : `${header}\n\n📭 No saved messages yet — tap ✍️ to write one.`,
        kb,
        true,
      );
      return;
    }

    if (action === 'new') {
      // Custom message straight to this person, written on the fly. The compose
      // tail sees the seeded target and offers "Review & send" (no group step).
      session.broadcast = { groupIds: [], subscriberIds: [arg] };
      await this.enterConvo(ctx, 'composeBroadcastMsg');
      return;
    }

    if (action === 'pick') {
      // arg is "subscriberId:notificationId". Preview + how-to-use choice —
      // mirrors the broadcast composer, so a direct send can also rewrite or
      // top up the selected message before it goes out.
      const sep = arg.lastIndexOf(':');
      const subId = arg.slice(0, sep);
      const notifId = arg.slice(sep + 1);
      session.broadcast = {
        notificationId: notifId,
        groupIds: [],
        subscriberIds: [subId],
      };
      const [n, who] = await Promise.all([
        this.notifications.get(p.sourceId, notifId),
        this.subscribers
          .list(p.sourceId)
          .then((all) => all.find((x) => x.id === subId)),
      ]);
      const kb = new InlineKeyboard()
        .text('➡️ Send as is', `sub:go:${arg}`)
        .row()
        .text('✏️ Edit message', `bc:edit:${notifId}`)
        .row()
        .text('➕ Add text on top', `bc:adjust:${notifId}`)
        .row()
        .text('⬅️ Back', `sub:send:${subId}`);
      const to = who ? `\n\n<i>To: ${esc(who.displayName)}</i>` : '';
      await this.render(ctx, this.notifPreview(n) + to, kb, true);
      return;
    }

    if (action === 'go') {
      // "Send as is" — the immediate path (placeholder prompts first if needed).
      // arg is "subscriberId:notificationId"; re-seed the session so the button
      // still works after a restart wiped the in-memory state.
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
        const lines = data.responses.map(
          (r) => `<b>${esc(r.displayName)}</b>: ${esc(r.text ?? '')}`,
        );
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
      kb.text(
        `${selected.has(s.id) ? '✅' : '⬜'} ${s.displayName}`,
        `bc:stog:${s.id}:${pg}`,
      ).row();
    });
    this.navRow(kb, 'bc:people:', pg, pages);
    // Same forward affordance as the groups screen — nobody should have to go
    // "back" to move forward.
    if (this.hasTargets(session.broadcast ?? {})) kb.text('▶️ Continue', 'bc:go').row();
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
    // Name the direct recipients (first few) — "to: Оля" beats "to: 1 person".
    const subs = b.subscriberIds?.length
      ? await this.subscribers.list(p.sourceId)
      : [];
    const personNames = (b.subscriberIds ?? [])
      .map((id) => subs.find((s) => s.id === id)?.displayName)
      .filter((x): x is string => !!x);
    const shown = personNames.slice(0, 3);
    const more = personNames.length - shown.length;
    const parts = [
      ...groupNames,
      ...shown,
      ...(more > 0 ? [`+${more} more`] : []),
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

  /** The draft this button belonged to no longer exists — the process was
   *  restarted, or the send already went out and cleared it. A clean restart
   *  beats a crash or a silent dead tap. */
  private async renderExpiredFlow(ctx: Context): Promise<void> {
    const kb = new InlineKeyboard()
      .text('📣 New broadcast', 'bc:start')
      .row()
      .text('🏠 Menu', 'menu:home');
    await this.render(
      ctx,
      '⌛ <b>This send flow has expired</b> (or was already completed).\nStart a new one below.',
      kb,
      true,
    );
  }

  /** Send a broadcast with no placeholders (the placeholder path uses bcFill). */
  private async doSend(ctx: Context, p: AuthPrincipal): Promise<void> {
    const session = getSession(ctx.from!.id);
    const b = session.broadcast;
    // Double-tap safety: the first ✅ Send clears the session; a queued second
    // tap (or any stale button) must not crash on the missing draft.
    if (!b?.notificationId) return this.renderExpiredFlow(ctx);
    const direct = await this.directLabel(
      p.sourceId,
      b.groupIds ?? [],
      b.subscriberIds ?? [],
    );
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
    await this.render(
      ctx,
      this.sentSummary(view.totalCount, (b.groupIds ?? []).length, direct),
      kb,
      true,
    );
  }

  /** For a single-person direct send, that person's display name (else null). */
  private async directLabel(
    sourceId: string,
    groupIds: string[],
    subscriberIds: string[],
  ): Promise<string | null> {
    if (groupIds.length || subscriberIds.length !== 1) return null;
    const s = (await this.subscribers.list(sourceId)).find(
      (x) => x.id === subscriberIds[0],
    );
    return s?.displayName ?? null;
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
      `Updates arrive right here — no commands to run. ` +
      `When a message asks for a response, just tap its buttons.\n\n` +
      `Send /stop anytime to unsubscribe.`
    );
  }

  /** Buttons under the reader card / join message: subscriber self-service.
   *  Public so {@link BotRunner} attaches the same actions on its replies. */
  consumerKeyboard(): InlineKeyboard {
    return new InlineKeyboard().text('✏️ Change my name', 'self:ren');
  }

  /** Reply to a non-owner: reader card if subscribed, else a connect prompt. */
  private async replyNonOwner(ctx: Context, tgId: bigint): Promise<void> {
    const subs = await this.subscribers.activeSubscriptionsByTelegramId(tgId);
    if (subs.length) {
      await ctx.reply(this.consumerMessage(subs.map((s) => s.sourceName)), {
        parse_mode: 'HTML',
        reply_markup: this.consumerKeyboard(),
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
    bot.use(createConversation(this.editBroadcastMsgConvo as never, 'editBroadcastMsg') as never);
    bot.use(createConversation(this.renameSubscriberConvo as never, 'renameSubscriber') as never);
    bot.use(createConversation(this.renameSelfConvo as never, 'renameSelf') as never);
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
      if (await this.isCancel(u)) return this.cancelled(ctx, u);
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
      if (await this.isCancel(u)) return this.cancelled(ctx, u);
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
      if (await this.isCancel(u)) return this.cancelled(ctx, u);
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
      if (await this.isCancel(u)) return this.cancelled(ctx, u);
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
      if (await this.isCancel(u)) return this.cancelled(ctx, u);
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
    let n: NotificationView;
    try {
      n = await conversation.external(() => this.notifications.get(sourceId, notifId));
    } catch {
      // The template was archived/deleted between tapping the button and here.
      return void (await ctx.reply('That message no longer exists.', {
        reply_markup: this.homeKeyboard(),
      }));
    }
    const values: Record<string, string> = {};
    for (const ph of n.placeholders) {
      await ctx.reply(`✏️ Value for <b>{${esc(ph)}}</b>:`, {
        parse_mode: 'HTML',
        reply_markup: cancel,
      });
      for (;;) {
        const u = await conversation.wait();
        if (await this.isCancel(u)) return this.cancelled(ctx, u);
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
    const direct = await conversation.external(() =>
      this.directLabel(sourceId, groupIds, subscriberIds),
    );
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
      await ctx.reply(this.sentSummary(view.totalCount, groupIds.length, direct), {
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
      if (await this.isCancel(u)) return this.cancelled(ctx, u);
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
      if (await this.isCancel(u)) return this.cancelled(ctx, u);
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
   * (possibly ephemeral) notification, then hand off via {@link handoffComposed}.
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
      if (await this.isCancel(u)) return this.cancelled(ctx, u);
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

    const note = ephemeral
      ? '<i>One-time message — not saved to your gallery.</i>'
      : `<i>Saved as “${esc(created.name)}”.</i>`;
    await this.handoffComposed(conversation, ctx, created, note);
  };

  /**
   * Shared handoff after a message is composed/edited: stash it on the session
   * — PRESERVING any target the entry point seeded (the direct-to-subscriber
   * flow pre-picks the recipient) — then hand off via a button so nav stays
   * edit-in-place: straight to review when a target is set, else the picker.
   */
  private handoffComposed = async (
    conversation: Conv,
    ctx: Context,
    n: NotificationView,
    note: string,
  ): Promise<void> => {
    const hasTargets = await conversation.external(() => {
      const s = getSession(ctx.from!.id);
      s.broadcast = {
        ...s.broadcast,
        notificationId: n.id,
        groupIds: s.broadcast?.groupIds ?? [],
        subscriberIds: s.broadcast?.subscriberIds ?? [],
      };
      return this.hasTargets(s.broadcast);
    });
    const ph = n.placeholders.length
      ? `\n<i>You'll fill ${esc(n.placeholders.map((x) => `{${x}}`).join(', '))} before it sends.</i>`
      : '';
    const kb = new InlineKeyboard();
    if (hasTargets) kb.text('▶️ Review & send', 'bc:now');
    else kb.text('▶️ Choose recipients', 'bc:groups');
    kb.row().text('✖ Cancel', 'menu:home');
    await ctx.reply(
      `✅ Ready. ${note}${ph}\n\n` +
        (hasTargets ? 'Review the send to finish.' : 'Now pick who gets it.'),
      { parse_mode: 'HTML', reply_markup: kb },
    );
  };

  /**
   * Rewrite the selected message before sending. The owner sends replacement
   * text, then picks the blast radius: use it for this send only (the saved
   * template stays untouched) or update the template in place (permanent).
   */
  private editBroadcastMsgConvo = async (
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
      `✏️ <b>Edit</b> “${esc(base.name)}”.\n\n<i>Current message:</i>\n${esc(preview)}\n\n` +
        'Send the new text — it <b>replaces</b> the message above.',
      { parse_mode: 'HTML', reply_markup: cancel },
    );
    let body = '';
    for (;;) {
      const u = await conversation.wait();
      if (await this.isCancel(u)) return this.cancelled(ctx, u);
      const t = u.message?.text;
      if (!t || !t.trim()) {
        await ctx.reply('Please send the new text, or ✖ Cancel.', { reply_markup: cancel });
        continue;
      }
      body = t;
      break;
    }

    const modeKb = new InlineKeyboard()
      .text('1️⃣ Just this send', 'convo:save:once')
      .text('💾 Update template', 'convo:save:keep')
      .row()
      .text('✖ Cancel', 'convo:cancel');
    const finalPreview = body.length > 600 ? `${body.slice(0, 600)}…` : body;
    await ctx.reply(
      `📄 <b>Your message</b>\n\n${esc(finalPreview)}\n\n` +
        '💾 <b>Apply how?</b>\n<i>“Just this send” leaves the saved template ' +
        'unchanged; “Update template” saves this text permanently.</i>',
      { parse_mode: 'HTML', reply_markup: modeKb },
    );
    let permanent = false;
    for (;;) {
      const u = await conversation.wait();
      const d = u.callbackQuery?.data;
      if (d === 'convo:save:once' || d === 'convo:save:keep') {
        await u.answerCallbackQuery().catch(() => undefined);
        permanent = d === 'convo:save:keep';
        break;
      }
      if (await this.isCancel(u)) return this.cancelled(ctx, u);
      await ctx.reply('Tap “Just this send” or “Update template”.', { reply_markup: modeKb });
    }

    let n: NotificationView;
    try {
      n = await conversation.external(() =>
        permanent
          ? this.notifications.update(sourceId, baseId, { body })
          : this.notifications.createInline(sourceId, {
              body,
              name: `${base.name} (edited)`,
              ephemeral: true,
            }),
      );
    } catch (err) {
      return void (await ctx.reply(`⚠️ ${esc(humanError(err))}`, {
        parse_mode: 'HTML',
        reply_markup: this.homeKeyboard(),
      }));
    }
    const note = permanent
      ? `<i>Template “${esc(n.name)}” updated for future sends too.</i>`
      : '<i>One-time version — the saved template is unchanged.</i>';
    await this.handoffComposed(conversation, ctx, n, note);
  };

  /**
   * Give a subscriber a friendly display name (visible to the owner only).
   * Reset clears the override, falling back to the name the subscriber chose
   * for themselves (if any), else their Telegram profile name.
   */
  private renameSubscriberConvo = async (
    conversation: Conv,
    ctx: Context,
    subId: string,
  ): Promise<void> => {
    const sourceId = await conversation.external(() => this.ownerSourceId(ctx));
    if (!sourceId) return void (await ctx.reply('You are not connected to a workspace.'));
    const s = await conversation.external(async () =>
      (await this.subscribers.list(sourceId)).find((x) => x.id === subId),
    );
    if (!s) {
      return void (await ctx.reply('That subscriber no longer exists.', {
        reply_markup: this.homeKeyboard(),
      }));
    }
    const kb = new InlineKeyboard();
    if (s.customName) kb.text('↩️ Reset to their own name', 'convo:reset');
    kb.text('✖ Cancel', 'convo:cancel');
    await ctx.reply(
      `✏️ <b>Rename</b> “${esc(s.displayName)}”\nSend the new name — only you will see it:`,
      { parse_mode: 'HTML', reply_markup: kb },
    );
    for (;;) {
      const u = await conversation.wait();
      let newName: string | null;
      if (u.callbackQuery?.data === 'convo:reset') {
        await u.answerCallbackQuery().catch(() => undefined);
        newName = null;
      } else {
        if (await this.isCancel(u)) return this.cancelled(ctx, u);
        const t = (u.message?.text ?? '').trim();
        if (!t) {
          await ctx.reply('Please send a name as text, or ✖ Cancel.', { reply_markup: kb });
          continue;
        }
        if (t.length > 120) {
          await ctx.reply('That name is too long (max 120). Try a shorter one.', {
            reply_markup: kb,
          });
          continue;
        }
        newName = t;
      }
      try {
        const v = await conversation.external(() =>
          this.subscribers.rename(sourceId, subId, newName),
        );
        await ctx.reply(`✅ Now shown as <b>${esc(v.displayName)}</b>.`, {
          parse_mode: 'HTML',
          reply_markup: new InlineKeyboard()
            .text('👤 Back to subscriber', `sub:view:${subId}`)
            .row()
            .text('🏠 Menu', 'menu:home'),
        });
      } catch (err) {
        await ctx.reply(`⚠️ ${esc(humanError(err))}`, {
          parse_mode: 'HTML',
          reply_markup: this.homeKeyboard(),
        });
      }
      return;
    }
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
      if (await this.isCancel(u)) return this.cancelled(ctx, u);
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

  /**
   * A subscriber picks the name workspaces see for them (“Change my name” on
   * the reader card / join message). One name per person — it applies to every
   * workspace they follow. An owner's per-workspace rename still wins where
   * set. Subscriber-facing: cancels are quiet, no admin menu anywhere.
   */
  private renameSelfConvo = async (conversation: Conv, ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const current = await conversation.external(() =>
      this.subscribers.selfNameByTelegramId(BigInt(tgId)),
    );
    const kb = new InlineKeyboard();
    if (current) kb.text('↩️ Use my Telegram name', 'convo:reset');
    kb.text('✖ Cancel', 'convo:cancel');
    await ctx.reply(
      current
        ? `✏️ You appear as <b>${esc(current)}</b>.\nSend the name to show instead:`
        : '✏️ <b>What should we call you?</b>\nSend your name:',
      { parse_mode: 'HTML', reply_markup: kb },
    );
    for (;;) {
      const u = await conversation.wait();
      let newName: string | null;
      if (u.callbackQuery?.data === 'convo:reset') {
        await u.answerCallbackQuery().catch(() => undefined);
        newName = null;
      } else if (u.callbackQuery?.data === 'self:ren') {
        // Duplicate tap on the entry button — we're already asking. Just
        // clear the spinner and keep waiting for the name.
        await u.answerCallbackQuery().catch(() => undefined);
        continue;
      } else if (u.callbackQuery || (u.message?.text ?? '').startsWith('/')) {
        // Any other tap or command exits quietly (plain cancel, no owner menu).
        if (u.callbackQuery) await u.answerCallbackQuery().catch(() => undefined);
        return void (await ctx.reply('✖ Cancelled.'));
      } else {
        const t = (u.message?.text ?? '').trim();
        if (!t) {
          await ctx.reply('Please send your name as text, or ✖ Cancel.', { reply_markup: kb });
          continue;
        }
        if (t.length > 120) {
          await ctx.reply('That name is too long (max 120). Try a shorter one.', {
            reply_markup: kb,
          });
          continue;
        }
        newName = t;
      }
      try {
        const count = await conversation.external(() =>
          this.subscribers.renameSelf(BigInt(tgId), newName),
        );
        if (!count) {
          await ctx.reply(
            "You're not subscribed to anything yet — open an invite link first.",
          );
          return;
        }
        await ctx.reply(
          newName
            ? `✅ Done — you'll now appear as <b>${esc(newName)}</b>.`
            : '✅ Done — your Telegram profile name will be shown.',
          { parse_mode: 'HTML' },
        );
      } catch (err) {
        await ctx.reply(`⚠️ ${esc(humanError(err))}`, { parse_mode: 'HTML' });
      }
      return;
    }
  };

  /**
   * A subscriber taps “Answer” → capture one free-text reply and record it.
   * Subscriber-facing, so while they're typing we still honour the buttons that
   * ride along on other messages: a poll vote is recorded inline (not swallowed),
   * a stray Answer tap is ignored, /stop actually unsubscribes, and ✖ Cancel /
   * other commands exit quietly.
   */
  private answerQuestionConvo = async (
    conversation: Conv,
    ctx: Context,
    broadcastId: string,
  ): Promise<void> => {
    const cancel = new InlineKeyboard().text('✖ Cancel', 'convo:cancel');
    await ctx.reply('✍️ Type your answer:', { reply_markup: cancel });
    const tgId = ctx.from!.id;
    let answer = '';
    for (;;) {
      const u = await conversation.wait();
      const data = u.callbackQuery?.data ?? '';
      const [ns, cbBroadcastId, idxRaw] = data.split(':');

      // A poll vote on another message must NOT be lost just because an answer
      // prompt is open — record it inline and keep waiting for the answer.
      if (ns === 'rv') {
        try {
          const { label } = await conversation.external(() =>
            this.responses.recordVote(cbBroadcastId, tgId, parseInt(idxRaw, 10)),
          );
          await u.answerCallbackQuery({ text: `✅ Recorded: ${label}` }).catch(() => undefined);
        } catch (err) {
          await u
            .answerCallbackQuery({ text: `⚠️ ${humanError(err)}`, show_alert: true })
            .catch(() => undefined);
        }
        continue;
      }
      // A stray tap on an Answer button (incl. double-tapping this one) — we're
      // already collecting an answer; just clear the spinner and keep waiting.
      if (ns === 'ra') {
        await u.answerCallbackQuery().catch(() => undefined);
        continue;
      }
      if (data === 'convo:cancel') {
        await u.answerCallbackQuery().catch(() => undefined);
        return void (await ctx.reply('✖ Cancelled.'));
      }
      const text = u.message?.text ?? '';
      // /stop mid-answer must actually unsubscribe (not be swallowed as a cancel).
      if (text.startsWith('/stop')) {
        const count = await conversation.external(() =>
          this.subscribers.unsubscribeByTelegramId(BigInt(tgId)),
        );
        return void (await ctx.reply(
          count > 0
            ? "🛑 Unsubscribed. You won't receive further messages."
            : "You weren't subscribed to anything.",
        ));
      }
      if (text.startsWith('/') || u.callbackQuery) {
        if (u.callbackQuery) await u.answerCallbackQuery().catch(() => undefined);
        return void (await ctx.reply('✖ Cancelled.'));
      }
      if (!text.trim()) {
        await ctx.reply('Please send your answer as text, or ✖ Cancel.', { reply_markup: cancel });
        continue;
      }
      answer = text;
      break;
    }
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
    let n: NotificationView;
    try {
      n = await conversation.external(() => this.notifications.get(sourceId, notifId));
    } catch {
      return void (await ctx.reply('That message no longer exists.', {
        reply_markup: this.homeKeyboard(),
      }));
    }

    // 1) When
    await ctx.reply(
      '⏰ <b>When?</b>\nReply with <code>+30m</code>, <code>+2h</code>, <code>+1d</code>, ' +
        'or a UTC time like <code>2026-07-05 14:30</code>.',
      { parse_mode: 'HTML', reply_markup: cancel },
    );
    let sendAt: Date;
    for (;;) {
      const u = await conversation.wait();
      if (await this.isCancel(u)) return this.cancelled(ctx, u);
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
      if (await this.isCancel(u)) return this.cancelled(ctx, u);
      await ctx.reply('Tap Once, Daily, or Weekly.', { reply_markup: repKb });
    }

    // 3) Placeholders (if any)
    const values: Record<string, string> = {};
    for (const ph of n.placeholders) {
      await ctx.reply(`✏️ Value for <b>{${esc(ph)}}</b>:`, { parse_mode: 'HTML', reply_markup: cancel });
      for (;;) {
        const u = await conversation.wait();
        if (await this.isCancel(u)) return this.cancelled(ctx, u);
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

  /**
   * A guided flow is cancelled ONLY by its explicit ✖ Cancel button or a slash
   * command (the user navigated away). Any OTHER stray callback — an old menu
   * button, or a double-tap on the very button that opened this flow — is acked
   * (so no spinner hangs) and ignored, so it can't silently kill the flow; the
   * caller's loop then reprompts. (Fixes double-tap-cancels-the-conversation.)
   */
  private async isCancel(u: Context): Promise<boolean> {
    if (u.message?.text?.startsWith('/')) return true;
    if (u.callbackQuery) {
      if (u.callbackQuery.data === 'convo:cancel') return true;
      await u.answerCallbackQuery().catch(() => undefined); // clear spinner, ignore
      return false;
    }
    return false;
  }

  private async cancelled(ctx: Context, u: Context): Promise<void> {
    if (u.callbackQuery) await u.answerCallbackQuery().catch(() => undefined);
    // Cancelling a guided flow discards its in-progress broadcast draft too.
    if (ctx.from) getSession(ctx.from.id).broadcast = undefined;
    await ctx.reply('✖ Cancelled.', { reply_markup: this.homeKeyboard() });
  }

  private async ownerSourceId(ctx: Context): Promise<string | null> {
    if (!ctx.from) return null;
    const p = await this.sources.resolveByTelegramId(BigInt(ctx.from.id));
    return p?.sourceId ?? null;
  }

  private homeKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text('✍️ Quick message', 'bc:new')
      .row()
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

  private sentSummary(
    recipients: number,
    groupCount: number,
    direct?: string | null,
  ): string {
    if (recipients === 0) {
      return '📭 No active recipients — nothing was sent.';
    }
    // Set the expectation for the 📬 delivery report that follows.
    const confirm = "\n<i>I'll confirm once delivered.</i>";
    if (direct) return `✅ <b>On its way</b> to ${esc(direct)}.${confirm}`;
    const people = recipients === 1 ? '1 person' : `${recipients} people`;
    if (groupCount === 0) return `✅ <b>On its way</b> to ${people}.${confirm}`;
    const groups = groupCount === 1 ? '1 group' : `${groupCount} groups`;
    return `✅ <b>On its way</b> to ${people} (${groups}).${confirm}`;
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
      try {
        await ctx.editMessageText(text, opts);
      } catch (err) {
        // "message is not modified" = same content, safe to ignore. Anything
        // else (most often: the message is >48h old, which Telegram refuses to
        // edit) → fall back to a fresh card so the tap isn't a silent dead end.
        const desc = (err as { description?: string }).description ?? '';
        if (!desc.includes('message is not modified')) {
          await ctx.reply(text, opts).catch(() => undefined);
        }
      }
    } else {
      await ctx.reply(text, opts);
    }
  }
}
