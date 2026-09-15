/**
 * The slim bar above the composer: how full the context is, and WHEN the
 * conversation will be compacted.
 *
 * WHY A SEPARATE MODULE. The arithmetic is in `context/budget.ts` and the DOM is
 * in `sidepanel.ts`; what sits between them is a set of judgements about what to
 * SAY, and those are the part that can be wrong without anything failing. A bar
 * that reads 100% on a fresh conversation, or that stays silent until the
 * transcript is truncated, type-checks perfectly.
 *
 * THE LABEL NAMES THE EVENT, NOT JUST THE NUMBER. "Context 88%" tells a user
 * nothing they can act on — 88% of what, and what happens at 100%? The answer is
 * that earlier turns get summarised, which is a thing worth knowing BEFORE it
 * happens, because it is the moment to say "and remember X" if X matters. So the
 * label starts naming the event as the bar fills, rather than the first time it
 * fires.
 *
 * The token count is an estimate (`len / 4` — see `budget.ts`), so the bar shows
 * a percentage and never a token figure. A precise-looking "48,213 tokens" from
 * an estimator that runs ±20% is a more confident claim than we can support.
 */

import type { ContextBudgetHealth, ContextStatus } from "../context/budget";

export interface ContextBarView {
  /** Hidden when there is nothing honest to show. */
  hidden: boolean;
  /** 0..1, already clamped — a bar cannot be more than full. */
  fill: number;
  health: ContextBudgetHealth;
  label: string;
  /** The bar pulses while compaction is actually running. */
  busy: boolean;
}

const HIDDEN: ContextBarView = {
  hidden: true,
  fill: 0,
  health: "healthy",
  label: "",
  busy: false,
};

/**
 * At what fullness the label starts mentioning compaction.
 *
 * Tied to `budgetHealth`'s "critical" boundary rather than a second number of
 * its own, so there is one place where "getting full" is defined. Below it the
 * bar is ambient; above it, it is a warning.
 */
const NAME_THE_EVENT_AT: ContextBudgetHealth[] = ["critical", "over"];

/**
 * What the bar should show.
 *
 * `status === null` means the proxy reported no context window for this tier —
 * unknown, not zero. HIDING IS THE ONLY HONEST ANSWER: a bar drawn from a
 * missing window is drawn from `usable = 0`, which reads as permanently full.
 *
 * An empty conversation hides it too. A 0% bar above an empty composer is
 * chrome that teaches the user nothing and never changes on the screen they
 * spend the most time looking at.
 */
export function contextBarView(
  status: ContextStatus | null,
  opts: { compacting?: boolean; hasMessages?: boolean } = {},
): ContextBarView {
  if (!status) return HIDDEN;
  if (opts.hasMessages === false && !opts.compacting) return HIDDEN;

  const percent = Math.round(Math.min(1, Math.max(0, status.ratio)) * 100);

  if (opts.compacting) {
    return {
      hidden: false,
      fill: 1,
      health: "over",
      label: "Summarising earlier turns to make room…",
      busy: true,
    };
  }

  const label = status.willCompact
    ? "Context full · earlier turns are summarised on the next message"
    : NAME_THE_EVENT_AT.includes(status.health)
      ? `Context ${percent}% · earlier turns are summarised at 100%`
      : `Context ${percent}%`;

  return {
    hidden: false,
    fill: Math.min(1, Math.max(0, status.ratio)),
    health: status.health,
    label,
    busy: false,
  };
}
