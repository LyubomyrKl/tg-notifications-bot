import { z } from 'zod';

/**
 * The wire contract for the platform API. Both the Nest app (request validation)
 * and the future web dashboard (typed requests/responses) import these, so the
 * two clients can never drift. Add new slices' DTOs here.
 */

// ── Auth (web dashboard, email/password → JWT) ──────────────────────────────
export const RegisterInput = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  // Name for the workspace created alongside the account.
  workspaceName: z.string().min(1).max(120),
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const AuthResult = z.object({
  token: z.string(),
  user: z.object({ id: z.string(), email: z.string().email() }),
  source: z.object({ id: z.string(), name: z.string() }),
});
export type AuthResult = z.infer<typeof AuthResult>;

/** Registration also mints the workspace's REST API key — shown here exactly
 *  once (only the hash is stored), so the operator can hand it off. */
export const RegisterResult = AuthResult.extend({
  apiKey: z.string(),
});
export type RegisterResult = z.infer<typeof RegisterResult>;

// ── Source provisioning ─────────────────────────────────────────────────────
export const CreateSourceInput = z.object({
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(8),
  name: z.string().min(1).max(120),
});
export type CreateSourceInput = z.infer<typeof CreateSourceInput>;

export const SourceView = z.object({
  id: z.string(),
  name: z.string(),
  telegramUserId: z.string().nullable(), // BigInt serialized as string
  telegramLinked: z.boolean(),
  startLink: z.string(), // t.me/<bot>?start=<token>
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type SourceView = z.infer<typeof SourceView>;

/** Returned once at provisioning — the only time the raw API key is shown. */
export const SourceCredentials = SourceView.extend({
  apiKey: z.string(),
});
export type SourceCredentials = z.infer<typeof SourceCredentials>;

// ── Notifications (template gallery) ────────────────────────────────────────
const MediaInput = z.object({
  mediaUrl: z.string().url(),
  mediaType: z.string().min(1).max(40),
});

/** Telegram's hard cap on a single text message. A longer body fails every
 *  recipient at send time, so we reject it up front. */
export const MAX_MESSAGE_LENGTH = 4096;

export const CreateNotificationInput = z
  .object({
    name: z.string().min(1).max(160),
    body: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  })
  .merge(MediaInput.partial());
export type CreateNotificationInput = z.infer<typeof CreateNotificationInput>;

// Partial — any subset of fields may be edited.
export const UpdateNotificationInput = CreateNotificationInput.partial();
export type UpdateNotificationInput = z.infer<typeof UpdateNotificationInput>;

export const PreviewNotificationInput = z.object({
  // Values for the template's named placeholders, e.g. { title: "Launch" }.
  placeholderValues: z.record(z.string()).default({}),
});
export type PreviewNotificationInput = z.infer<typeof PreviewNotificationInput>;

export const NotificationView = z.object({
  id: z.string(),
  name: z.string(),
  body: z.string(),
  mediaUrl: z.string().nullable(),
  mediaType: z.string().nullable(),
  placeholders: z.array(z.string()),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type NotificationView = z.infer<typeof NotificationView>;

// ── Groups (subscriber segments) ────────────────────────────────────────────
export const CreateGroupInput = z.object({
  name: z.string().min(1).max(120),
});
export type CreateGroupInput = z.infer<typeof CreateGroupInput>;

export const RenameGroupInput = z.object({
  name: z.string().min(1).max(120),
});
export type RenameGroupInput = z.infer<typeof RenameGroupInput>;

export const AddMembersInput = z.object({
  subscriberIds: z.array(z.string().min(1)).min(1),
});
export type AddMembersInput = z.infer<typeof AddMembersInput>;

export const GroupView = z.object({
  id: z.string(),
  name: z.string(),
  isAll: z.boolean(),
  memberCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type GroupView = z.infer<typeof GroupView>;

// ── Subscribers ─────────────────────────────────────────────────────────────
export const SubscriberView = z.object({
  id: z.string(),
  telegramUserId: z.string(),
  username: z.string().nullable(),
  /** Telegram profile name captured at join / refreshed on interactions. */
  name: z.string().nullable(),
  /** Admin-set override; wins over everything else. */
  customName: z.string().nullable(),
  /** Subscriber-chosen name (set in the bot chat); below customName, above name. */
  selfName: z.string().nullable(),
  /** Ready-to-render label: customName → selfName → name → @username → telegram id. */
  displayName: z.string(),
  status: z.enum(['active', 'unsubscribed']),
  joinedAt: z.string(),
});
export type SubscriberView = z.infer<typeof SubscriberView>;

/** Admin rename; `customName: null` clears the override (back to Telegram name). */
export const RenameSubscriberInput = z.object({
  customName: z.string().trim().min(1).max(120).nullable(),
});
export type RenameSubscriberInput = z.infer<typeof RenameSubscriberInput>;

/** One entry of a subscriber's delivery history (per-person, incl. group sends). */
export const SubscriberHistoryEntry = z.object({
  broadcastId: z.string(),
  notificationName: z.string(),
  status: z.enum(['queued', 'sent', 'failed', 'blocked']),
  /** Delivery time when sent; the broadcast's creation time otherwise. */
  when: z.string(),
  error: z.string().nullable(),
});
export type SubscriberHistoryEntry = z.infer<typeof SubscriberHistoryEntry>;

// ── Invite links ────────────────────────────────────────────────────────────
export const CreateInviteLinkInput = z.object({
  // Optional bindings; both validated to belong to the caller's Source.
  groupId: z.string().min(1).optional(),
  notificationId: z.string().min(1).optional(),
  // ISO timestamp; omit for a non-expiring link.
  expiresAt: z.string().datetime().optional(),
});
export type CreateInviteLinkInput = z.infer<typeof CreateInviteLinkInput>;

export const InviteLinkView = z.object({
  id: z.string(),
  url: z.string(),
  token: z.string(),
  groupId: z.string().nullable(),
  /** Name of the bound group (joiners auto-added), or null = open to anyone. */
  groupName: z.string().nullable(),
  notificationId: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  active: z.boolean(), // not revoked and not expired
  joinCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type InviteLinkView = z.infer<typeof InviteLinkView>;

/** Per-link attribution: who joined through it and when. */
export const InviteJoinView = z.object({
  subscriberId: z.string(),
  telegramUserId: z.string(),
  username: z.string().nullable(),
  joinedAt: z.string(),
});
export type InviteJoinView = z.infer<typeof InviteJoinView>;

export const InviteLinkDetail = InviteLinkView.extend({
  joins: z.array(InviteJoinView),
});
export type InviteLinkDetail = z.infer<typeof InviteLinkDetail>;

// ── Broadcasts ──────────────────────────────────────────────────────────────

/** Optional two-way interaction attached to a send. A poll needs 2–4 option
 *  labels; a question needs none (it invites a free-text reply). */
export const BroadcastInteractionInput = z
  .object({
    type: z.enum(['poll', 'question']),
    options: z.array(z.string().min(1).max(64)).max(4).default([]),
  })
  .refine(
    (v) => (v.type === 'question' ? v.options.length === 0 : v.options.length >= 2),
    { message: 'A poll needs 2–4 options; a question needs none', path: ['options'] },
  );
export type BroadcastInteractionInput = z.infer<typeof BroadcastInteractionInput>;

export const CreateBroadcastInput = z
  .object({
    notificationId: z.string().min(1),
    // Target groups (use the "All" group id to reach everyone).
    groupIds: z.array(z.string().min(1)).default([]),
    // Target specific subscribers directly (e.g. a 1:1 message). Merged + deduped
    // with the group recipients.
    subscriberIds: z.array(z.string().min(1)).default([]),
    placeholderValues: z.record(z.string()).default({}),
    // Optional poll/question the recipients can respond to.
    interaction: BroadcastInteractionInput.optional(),
    // Caller-supplied idempotency key — a retried send with the same key is a no-op.
    sendKey: z.string().min(1).max(200),
  })
  .refine((v) => v.groupIds.length > 0 || v.subscriberIds.length > 0, {
    message: 'Provide at least one target group or subscriber',
    path: ['groupIds'],
  });
export type CreateBroadcastInput = z.infer<typeof CreateBroadcastInput>;

/** How a broadcast asks for a response, as returned by the API. */
export const InteractionView = z.object({
  type: z.enum(['none', 'poll', 'question']),
  options: z.array(z.string()),
});
export type InteractionView = z.infer<typeof InteractionView>;

export const BroadcastView = z.object({
  id: z.string(),
  notificationId: z.string(),
  status: z.enum(['queued', 'sending', 'completed', 'failed']),
  groupIds: z.array(z.string()),
  /** Snapshot of targeted group names at send time — survives group deletion. */
  groupNames: z.array(z.string()),
  interaction: InteractionView,
  responseCount: z.number().int().nonnegative(),
  createdBy: z.string(),
  totalCount: z.number().int().nonnegative(),
  sentCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  blockedCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type BroadcastView = z.infer<typeof BroadcastView>;

export const RecipientView = z.object({
  subscriberId: z.string(),
  status: z.enum(['queued', 'sent', 'failed', 'blocked']),
  error: z.string().nullable(),
  sentAt: z.string().nullable(),
});
export type RecipientView = z.infer<typeof RecipientView>;

export const BroadcastDetail = BroadcastView.extend({
  recipients: z.array(RecipientView),
});
export type BroadcastDetail = z.infer<typeof BroadcastDetail>;

/** One subscriber's response to an interactive broadcast. */
export const BroadcastResponseView = z.object({
  id: z.string(),
  subscriberId: z.string(),
  telegramUserId: z.string(),
  username: z.string().nullable(),
  /** Ready-to-render label (same precedence as SubscriberView.displayName). */
  displayName: z.string(),
  optionIndex: z.number().int().nullable(),
  text: z.string().nullable(),
  createdAt: z.string(),
});
export type BroadcastResponseView = z.infer<typeof BroadcastResponseView>;

/** Vote count for one poll option. */
export const PollTally = z.object({
  optionIndex: z.number().int(),
  label: z.string(),
  count: z.number().int().nonnegative(),
});
export type PollTally = z.infer<typeof PollTally>;

/** The full response picture for a broadcast: its interaction config, every
 *  individual response, and (for polls) per-option tallies. */
export const BroadcastResponses = z.object({
  interaction: InteractionView,
  responses: z.array(BroadcastResponseView),
  tallies: z.array(PollTally),
});
export type BroadcastResponses = z.infer<typeof BroadcastResponses>;

// ── Scheduled broadcasts ────────────────────────────────────────────────────
export const RepeatKind = z.enum(['none', 'daily', 'weekly']);
export type RepeatKind = z.infer<typeof RepeatKind>;

export const ScheduleBroadcastInput = z.object({
  notificationId: z.string().min(1),
  groupIds: z.array(z.string().min(1)).min(1),
  placeholderValues: z.record(z.string()).default({}),
  // First (or only) fire time, ISO 8601. Interpreted in UTC.
  sendAt: z.string().datetime(),
  repeat: RepeatKind.default('none'),
});
export type ScheduleBroadcastInput = z.infer<typeof ScheduleBroadcastInput>;

export const ScheduledBroadcastView = z.object({
  id: z.string(),
  notificationId: z.string(),
  groupIds: z.array(z.string()),
  sendAt: z.string(),
  repeat: RepeatKind,
  status: z.enum(['scheduled', 'completed', 'cancelled', 'failed']),
  createdBy: z.string(),
  lastRunAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ScheduledBroadcastView = z.infer<typeof ScheduledBroadcastView>;

// ── Audit log ───────────────────────────────────────────────────────────────
export const AuditEntryView = z.object({
  id: z.string(),
  actor: z.string(),
  action: z.string(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
});
export type AuditEntryView = z.infer<typeof AuditEntryView>;
