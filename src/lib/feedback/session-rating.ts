/**
 * "How is Atlarix doing this session?": 1 bad, 2 fine, 3 good, on every
 * surface (the app, the CLI and the VS Code panel ask; any editor takes
 * `/feedback`). For product feedback only, never used to train anything
 * (owner, 2026-10-05).
 *
 * Everyone is asked, analytics on or off; nothing is sent unless they answer
 * (owner, 2026-10-22). The old cadence (8 turns, a 1-in-3 draw, a week apart,
 * opted-in only) meant the owner never once saw it. Now: after 6 completed
 * turns in a session (owner: "more than 3, less than 8"), once per session,
 * and not again on ANY surface for 3 days after an answer or a dismissal.
 *
 * `ATLARIX_FORCE_RATING=1` asks after the first turn, for testing.
 */
export const RATING_AFTER_TURNS = 6;
export const RATING_QUIET_MS = 3 * 24 * 60 * 60 * 1000;
export const FEEDBACK_MAX = 2000;

export const RATINGS = { "1": "bad", "2": "fine", "3": "good" } as const;
export type RatingKey = keyof typeof RATINGS;

export const RATING_QUESTION = "How is Atlarix doing this session?";
export const RATING_SENDS = "Sends your rating, Atlarix version, model, mode and session length. Never your code or prompts.";
export const FEEDBACK_QUESTION = "What should we improve?";
export const FEEDBACK_THANKS = "Thanks. That helps us make Atlarix better.";
export const FEEDBACK_FAILED = "Couldn't send that. Try again later.";

export function shouldAskRating(o: {
  /** Turns completed in this session. */
  turns: number;
  /** When it was last answered or dismissed, anywhere (settings `sessionRatingAt`). */
  ratedAt?: number;
  now: number;
  /** Already asked in this session (answered, dismissed or skipped). */
  askedThisSession: boolean;
  /** ATLARIX_FORCE_RATING=1. */
  force?: boolean;
}): boolean {
  if (o.askedThisSession) return false;
  if (o.force) return o.turns >= 1;
  if (o.turns < RATING_AFTER_TURNS) return false;
  return o.ratedAt == null || o.now - o.ratedAt >= RATING_QUIET_MS;
}

/** How /feedback is used, said when it was used wrong ("/feedback 7"). */
export const FEEDBACK_USAGE = "Rate this session 1, 2 or 3 (1 bad, 2 fine, 3 good), or just write what to improve: /feedback 3 great at refactors";
export const FEEDBACK_TOO_LONG = `That's over ${FEEDBACK_MAX.toLocaleString("en-US")} characters. Shorten it and send it again.`;

/**
 * `/feedback 3 great on refactors` → a rating and/or text. A number that is not
 * 1-3 ("/feedback 7") is a rating gone wrong, not feedback text; text over the
 * limit is refused whole, never cut quietly (QA E3).
 */
export function parseFeedbackCommand(rest: string): {
  rating?: 1 | 2 | 3;
  body?: string;
  problem?: "rating" | "too_long";
} {
  const m = /^\s*([123])(?:\s+|$)([\s\S]*)$/.exec(rest);
  // A number alone that is not 1-3; "12 tabs is too many" is still text.
  if (!m && /^\s*\d+\s*$/.test(rest)) return { problem: "rating" };
  const rating = m ? (Number(m[1]) as 1 | 2 | 3) : undefined;
  const body = (m ? m[2]! : rest).trim();
  return {
    ...(rating ? { rating } : {}),
    ...(body ? { body } : {}),
    ...(body.length > FEEDBACK_MAX ? { problem: "too_long" as const } : {}),
  };
}
