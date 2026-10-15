/**
 * A reply the user stopped. Main saves it with a note for the model
 * (STOP_NOTE) so the next turn knows it was cut off; the user sees the
 * "interrupted… Continue" marker instead, live and after a reopen alike, and
 * never the note itself (QA 15.7.1 #7).
 */
import type { Message } from "@/ipc/ipc_types";

export const STOP_NOTE = "[Response cancelled by user]";

/** The reply as the user reads it: without the note main adds for the model. */
export function withoutStopNote(content: string): string {
  return content.includes(STOP_NOTE)
    ? content.replace(STOP_NOTE, "").trimEnd()
    : content;
}

/**
 * The chat right after the user stopped its turn: that turn's reply (the
 * assistant message after the last user message) is marked interrupted. The
 * same list comes back when there is none to mark.
 */
export function markStoppedReply(messages: Message[]): Message[] {
  const i = messages.length - 1;
  const last = messages[i];
  if (!last || last.role !== "assistant" || last.interrupted) return messages;
  const next = messages.slice();
  next[i] = {
    ...last,
    content: withoutStopNote(last.content ?? ""),
    interrupted: true,
  };
  return next;
}
