/**
 * Resolved caller identity. Every transport (JWT for web, API key for
 * programmatic, Telegram id for the bot) collapses to this shape, and the
 * service layer scopes ALL queries by `sourceId`. Tenant isolation therefore
 * holds no matter which client called — it's enforced below the controllers.
 */
export interface AuthPrincipal {
  /** The workspace every query must be scoped to. */
  sourceId: string;
  /** Present when authenticated as a web user (JWT). */
  userId?: string;
  /** Which transport authenticated this request. */
  via: 'jwt' | 'apiKey' | 'telegram';
}
