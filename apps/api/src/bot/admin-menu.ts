import { Injectable, Logger } from '@nestjs/common';
import {
  type AuthPrincipal,
  BroadcastService,
  GroupService,
  InviteService,
  NotificationService,
  ScheduleService,
  SourceService,
  SubscriberService,
} from '@paedavic/core';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { conversations, createConversation } from '@grammyjs/conversations';
import { type Bot, type Context, InlineKeyboard } from 'grammy';
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
  ) {}

  /** Wire the menu onto the bot. Call after command handlers are registered. */
  register(bot: Bot): void {
    // Command shortcuts that jump straight to a menu screen (same renderers).
    bot.command('menu', (ctx) => this.openHome(ctx, false));
    bot.command('notifications', (ctx) => this.openList(ctx, 'notif'));
    bot.command('groups', (ctx) => this.openList(ctx, 'grp'));
    bot.command('links', (ctx) => this.openList(ctx, 'inv'));
    bot.command('send', (ctx) => this.openSend(ctx));
    bot.command('scheduled', (ctx) => this.openScheduled(ctx));
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

  /** /scheduled → list upcoming scheduled broadcasts. */
  private async openScheduled(ctx: Context): Promise<void> {
    const p = await this.requireOwner(ctx);
    if (!p) return;
    await this.sch(ctx, p, 'list', '');
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
    await this.render(ctx, '<b>🏠 Menu</b>\nWhat would you like to do?', this.homeKeyboard(), edit);
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
      if (ns === 'sch') return void (await this.sch(ctx, principal, action, arg));
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
      kb.text('🏠 Menu', 'menu:home');
      await this.render(
        ctx,
        items.length
          ? '<b>📣 Broadcast</b>\nPick a notification to send:'
          : '<b>📣 Broadcast</b>\n\n📭 Create a notification first.',
        kb,
        true,
      );
      return;
    }
    if (action === 'notif') {
      session.broadcast = { notificationId: arg, groupIds: [] };
      await this.renderGroupSelect(ctx, p);
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
    if (action === 'go') {
      const b = session.broadcast;
      if (!b?.notificationId || !b.groupIds?.length) {
        await this.renderGroupSelect(ctx, p);
        return;
      }
      const kb = new InlineKeyboard()
        .text('✅ Send now', 'bc:now')
        .text('⏰ Schedule', 'bc:sched')
        .row()
        .text('✖ Cancel', 'menu:home');
      await this.render(ctx, '📣 Send now, or schedule for later?', kb, true);
      return;
    }
    if (action === 'now') {
      const b = session.broadcast!;
      const n = await this.notifications.get(p.sourceId, b.notificationId!);
      if (n.placeholders.length) {
        await this.enterConvo(ctx, 'bcFill', b.notificationId!, b.groupIds!.join(','));
        return;
      }
      await this.showConfirm(ctx, p);
      return;
    }
    if (action === 'sched') {
      const b = session.broadcast;
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

  /** Compact UTC label, e.g. "Jul 5 14:30". */
  private formatWhen(iso: string): string {
    const d = new Date(iso);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${months[d.getUTCMonth()]} ${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }

  /** Multi-select group picker for a broadcast (✅/⬜ toggles + Continue). */
  private async renderGroupSelect(ctx: Context, p: AuthPrincipal): Promise<void> {
    const session = getSession(ctx.from!.id);
    const selected = new Set(session.broadcast?.groupIds ?? []);
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
    if (selected.size > 0) kb.text('▶️ Continue', 'bc:go').row();
    kb.text('✖ Cancel', 'menu:home');
    await this.render(
      ctx,
      `<b>📣 Broadcast</b>\nSelect groups to send to (${selected.size} selected):`,
      kb,
      true,
    );
  }

  private async showConfirm(ctx: Context, p: AuthPrincipal): Promise<void> {
    const session = getSession(ctx.from!.id);
    const b = session.broadcast!;
    const n = await this.notifications.get(p.sourceId, b.notificationId!);
    const names = (await this.groups.list(p.sourceId))
      .filter((g) => b.groupIds!.includes(g.id))
      .map((g) => g.name)
      .join(', ');
    const kb = new InlineKeyboard()
      .text('✅ Send now', 'bc:send')
      .text('✖ Cancel', 'menu:home');
    await this.render(
      ctx,
      `📣 Send <b>${esc(n.name)}</b> to: ${esc(names)}?`,
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
        groupIds: b.groupIds!,
        placeholderValues: {},
        sendKey: `bot-${ctx.from!.id}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      },
      `telegram:${ctx.from!.id}`,
    );
    clearSession(ctx.from!.id);
    const kb = new InlineKeyboard().text('🏠 Menu', 'menu:home');
    await this.render(ctx, this.sentSummary(view.totalCount, b.groupIds!.length), kb, true);
  }

  // ── Free-text fallback ──────────────────────────────────────────────────────

  private async onText(ctx: Context): Promise<void> {
    const text = ctx.message?.text ?? '';
    if (text.startsWith('/')) return; // commands handled elsewhere
    const principal = await this.requireOwner(ctx);
    if (!principal) return;
    // Guided input is owned by conversations; a stray message just opens the menu.
    await this.openHome(ctx, false);
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
    bot.use(createConversation(this.scheduleBroadcastConvo as never, 'scheduleBroadcast') as never);
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
    try {
      const view = await conversation.external(() =>
        this.broadcasts.create(
          sourceId,
          {
            notificationId: notifId,
            groupIds,
            placeholderValues: values,
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
      .text('⏰ Scheduled', 'sch:list');
  }

  private sentSummary(recipients: number, groupCount: number): string {
    if (recipients === 0) {
      return '📭 No one to send to — those groups have no active subscribers yet.';
    }
    const people = recipients === 1 ? '1 person' : `${recipients} people`;
    const groups = groupCount === 1 ? '1 group' : `${groupCount} groups`;
    return `✅ <b>On its way</b> to ${people} (${groups}).`;
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
