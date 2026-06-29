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

export const CreateNotificationInput = z
  .object({
    name: z.string().min(1).max(160),
    body: z.string().min(1),
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
  status: z.enum(['active', 'unsubscribed']),
  joinedAt: z.string(),
});
export type SubscriberView = z.infer<typeof SubscriberView>;

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
