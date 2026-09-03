/**
 * Mid-turn user messages ("interjections") — the queue behind the composer's
 * chip, moved into MAIN and made a list.
 *
 * WHAT THIS REPLACES. A renderer-only `Map<number, string>`
 * (`queuedMessageByChatIdAtom`) holding exactly ONE message, flushed as a fresh
 * turn ~50ms after the stream ended. That had three defects the owner hit:
 *
 *  1. A second message was SILENTLY rejected. `SimpleChatInput.handleSubmit`
 *     early-returned when the slot was full, and Enter bypasses the disabled
 *     Send button — so the user got no feedback and their text just sat there.
 *  2. Being renderer state, it died on reload and could be dropped by a chat
 *     switch (`clearChatAtomsForChat`), which the ask_user hold made reachable:
 *     `isStreaming` is false while a question is up and the queue is full.
 *  3. Flushing as a NEW turn is not what the user asked for —
 *     "not cancel just come in as my message".
 *
 * SO WHY MODULE-LEVEL AND NOT ctx-SCOPED. `turn-context.ts`'s
 * `pendingEmptyOutputNudge` is the closest shape, but it is per-turn and
 * in-process: a renderer-originated message has no turn to attach to (it may
 * arrive between rounds, or with no turn live at all). Module-level, per chat,
 * is the shape every other background source already uses —
 * `background-commands.ts`, `subagent-results.ts`, `automation-results.ts`,
 * `scheduled-wakeups.ts`, `dropped-history-notice.ts` — each pairing a
 * destructive `takePending…` with a NON-destructive `hasPending…`. That pairing
 * is what the single-consumer invariant rests on, so it is kept here.
 *
 * DELIVERY IS UNTAGGED, and that is the whole point. See
 * `takePendingUserInterjections` — every other injection on this seam is
 * wrapped in `<system-reminder>`; this one must not be.
 */

export type UserInterjection = {
  /** Renderer-minted, so a cancel can name one before main has replied. */
  id: string;
  text: string;
  ts: number;
};

/**
 * Deliberately higher than the sub-agent cap (10): these are the USER's words.
 * Dropping one is worse than paying for it, and a human cannot type 40 messages
 * into one turn by accident.
 */
const MAX_QUEUED_PER_CHAT = 40;
/** Per message. A pasted wall of text is still a message worth delivering. */
const TEXT_CAP = 20_000;

const byChat = new Map<number, UserInterjection[]>();

/** main → renderer, so the chip can reflect the authoritative queue. */
let notifier: ((chatId: number, pending: UserInterjection[]) => void) | null =
  null;

export function setUserInterjectionNotifier(
  fn: (chatId: number, pending: UserInterjection[]) => void,
): void {
  notifier = fn;
}

function notify(chatId: number): void {
  notifier?.(chatId, listPendingUserInterjections(chatId));
}

export function recordUserInterjection(
  chatId: number,
  msg: { id: string; text: string; ts?: number },
): UserInterjection | null {
  const text = msg.text.trim();
  if (!text) return null;
  const list = byChat.get(chatId) ?? [];
  // Idempotent on id: a renderer retry (or a second window replaying the same
  // send) must not deliver the message twice.
  if (list.some((m) => m.id === msg.id)) return null;
  const entry: UserInterjection = {
    id: msg.id,
    text: text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}…` : text,
    ts: msg.ts ?? Date.now(),
  };
  list.push(entry);
  if (list.length > MAX_QUEUED_PER_CHAT) {
    console.warn(
      `[user-interjections] chat ${chatId}: >${MAX_QUEUED_PER_CHAT} undelivered — dropping ${list.length - MAX_QUEUED_PER_CHAT} oldest`,
    );
  }
  byChat.set(chatId, list.slice(-MAX_QUEUED_PER_CHAT));
  notify(chatId);
  return entry;
}

/** Non-destructive peek — the half `takePending…` must never be used for. */
export function hasPendingUserInterjections(chatId: number): boolean {
  return (byChat.get(chatId)?.length ?? 0) > 0;
}

/** Non-destructive read, for the composer chip. */
export function listPendingUserInterjections(
  chatId: number,
): UserInterjection[] {
  return [...(byChat.get(chatId) ?? [])];
}

/**
 * Take-once drain, oldest first.
 *
 * Returns the raw entries rather than a formatted block, unlike every sibling
 * store. Two reasons, both load-bearing:
 *
 *  - The caller emits each one as its OWN untagged `role:"user"` message, so
 *    a correction that follows a request still reads in the order it was typed.
 *    A single joined block would let a recency-biased model act on the last
 *    line only.
 *  - The caller also has to persist each one as a real transcript row, and that
 *    needs the individual text and id, not prose about them.
 */
export function takePendingUserInterjections(
  chatId: number,
): UserInterjection[] | null {
  const list = byChat.get(chatId);
  if (!list?.length) return null;
  byChat.delete(chatId);
  notify(chatId);
  return list;
}

/** Cancel one still-pending message. False when it was already delivered. */
export function cancelUserInterjection(chatId: number, id: string): boolean {
  const list = byChat.get(chatId);
  if (!list?.length) return false;
  const next = list.filter((m) => m.id !== id);
  if (next.length === list.length) return false;
  if (next.length) byChat.set(chatId, next);
  else byChat.delete(chatId);
  notify(chatId);
  return true;
}

/**
 * Take-once drain for the FALLBACK path: the turn ended without a further step,
 * so nothing was ever delivered mid-turn and the renderer opens a new turn with
 * these instead.
 *
 * Shares `takePendingUserInterjections`' take-once semantics deliberately —
 * whichever of the two gets there first wins, so a stream-end flush racing the
 * last step's drain can never deliver the same message twice.
 */
export function takeUserInterjectionsAsPrompt(chatId: number): string | null {
  const list = takePendingUserInterjections(chatId);
  if (!list) return null;
  // Joined for this path only: it becomes ONE new user turn, and separate turns
  // would each re-dispatch the model.
  return list.map((m) => m.text).join("\n\n");
}

export function clearUserInterjections(chatId: number): void {
  if (!byChat.has(chatId)) return;
  byChat.delete(chatId);
  notify(chatId);
}
