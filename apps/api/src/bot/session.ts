/**
 * Tiny in-memory session store for the bot's button UI. Keyed by Telegram user
 * id. Holds short-lived state for the few flows that need a text reply (naming a
 * group, filling placeholders) or multi-step selection (broadcast composition).
 *
 * In-memory is fine for the single-instance MVP; a Redis-backed store would slot
 * in here later without touching the menu code.
 */
export interface BotSession {
  /** What free-text reply the next message should be interpreted as, if any. */
  awaiting?: 'group_name' | 'placeholders' | 'notif_name' | 'notif_body';
  /** In-progress notification authoring (name → body). */
  notifDraft?: { name?: string };
  /** In-progress broadcast composition. */
  broadcast?: {
    notificationId?: string;
    groupId?: string;
    placeholderValues?: Record<string, string>;
  };
}

const store = new Map<number, BotSession>();

export function getSession(userId: number): BotSession {
  let s = store.get(userId);
  if (!s) {
    s = {};
    store.set(userId, s);
  }
  return s;
}

export function clearSession(userId: number): void {
  store.delete(userId);
}
