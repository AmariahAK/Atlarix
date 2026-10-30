/**
 * Whether a keypress answers the session-rating prompt ("1: Bad 2: Fine 3: Good
 * 0: Dismiss") or belongs to what the person is typing.
 *
 * QA 2026-10-30: with the prompt showing, a message typed into the composer had
 * every "1" eaten as a rating (the first one answered Bad and opened /feedback;
 * the rest followed). A digit is an answer only while the composer is EMPTY, so
 * the moment anything is typed the prompt stops taking keys; and the first
 * ordinary key typed snoozes the prompt until the next turn ends.
 */
export type RatingKey = "0" | "1" | "2" | "3";

export function ratingAnswerFor(
  key: { name?: string; ctrl?: boolean; meta?: boolean },
  state: { asking: boolean; composerText: string },
): RatingKey | null {
  if (!state.asking || key.ctrl || key.meta) return null;
  if (state.composerText.length > 0) return null;
  return key.name === "0" || key.name === "1" || key.name === "2" || key.name === "3" ? key.name : null;
}

/** A printable key that is not an answer: the person started typing, so the prompt steps aside. */
export function ratingSnoozesOn(key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }): boolean {
  if (key.ctrl || key.meta) return false;
  const n = key.name ?? "";
  if (["0", "1", "2", "3", "escape", "return", "tab", "up", "down", "left", "right", "pageup", "pagedown", "backspace", "delete"].includes(n)) return false;
  return (key.sequence ?? n).length === 1 || n === "space";
}
