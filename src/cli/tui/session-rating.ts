/**
 * "How is Atlarix doing this session?": an optional 1–3 rating, for product
 * feedback only — it is never used to train anything (owner, 2026-10-05). It
 * carries no prompt or code: the rating, the mode, the model and how long the
 * session ran.
 *
 * Asked rarely: only with analytics switched on, after a real session's worth
 * of turns, in about one session in three, and never within a week of the
 * last answer (or dismissal).
 */
export const RATING_AFTER_TURNS = 8;
export const RATING_QUIET_MS = 7 * 24 * 60 * 60 * 1000;
export const RATING_CHANCE = 1 / 3;

export const RATINGS = { "1": "bad", "2": "fine", "3": "good" } as const;

export function shouldAskRating(o: {
  consent: "opted_in" | "opted_out" | "unset" | null;
  turns: number;
  ratedAt?: number;
  now: number;
  /** This session drew the short straw (RATING_CHANCE). */
  sampled: boolean;
}): boolean {
  if (o.consent !== "opted_in" || !o.sampled) return false;
  if (o.turns < RATING_AFTER_TURNS) return false;
  return o.ratedAt == null || o.now - o.ratedAt >= RATING_QUIET_MS;
}
