import { type Broadcast, InteractionType } from '@paedavic/database';
import { InlineKeyboard } from '@paedavic/telegram';

/**
 * Callback-data namespaces for subscriber responses. Kept short so the full
 * `<ns>:<broadcastId>:<idx>` payload stays well under Telegram's 64-byte cap
 * (a cuid is 25 chars → e.g. `rv:cXXXXXXXXXXXXXXXXXXXXXXXX:3` ≈ 31 bytes).
 *   rv = poll vote     → `rv:<broadcastId>:<optionIndex>`
 *   ra = answer prompt → `ra:<broadcastId>`
 */
export const RESPONSE_CALLBACK = {
  vote: 'rv',
  answer: 'ra',
} as const;

export function voteCallback(broadcastId: string, optionIndex: number): string {
  return `${RESPONSE_CALLBACK.vote}:${broadcastId}:${optionIndex}`;
}

export function answerCallback(broadcastId: string): string {
  return `${RESPONSE_CALLBACK.answer}:${broadcastId}`;
}

/**
 * The inline keyboard for an interactive broadcast, or `undefined` for a plain
 * (`none`) send. Poll → one button per option; question → a single Answer button.
 */
export function buildInteractionKeyboard(
  broadcast: Pick<Broadcast, 'id' | 'interaction' | 'pollOptions'>,
): InlineKeyboard | undefined {
  if (broadcast.interaction === InteractionType.poll) {
    const kb = new InlineKeyboard();
    broadcast.pollOptions.forEach((label, i) => {
      kb.text(label, voteCallback(broadcast.id, i)).row();
    });
    return kb;
  }
  if (broadcast.interaction === InteractionType.question) {
    return new InlineKeyboard().text('✍️ Answer', answerCallback(broadcast.id));
  }
  return undefined;
}
