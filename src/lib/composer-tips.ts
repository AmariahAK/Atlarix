/**
 * Which tip to show under the composer, and when.
 *
 * Pure and free of React so the *policy* is testable without a render — the behaviour
 * here is the whole feature, and it is easy to get subtly wrong in ways that read as
 * noise rather than as a bug.
 *
 * THE POLICY, AND WHY EACH PART OF IT
 * -----------------------------------
 * The effect being copied is TIMING, not randomness. A tip is worth reading because it
 * occupies a moment when there is nothing else to read, and because it holds still while
 * you read it.
 *
 *  - **Eligible only on an empty composer with no turn running.** Mid-typing or
 *    mid-stream the user has something better to look at, and a line appearing under
 *    their cursor is an interruption.
 *  - **Chosen once per SESSION KEY, never on a timer.** A tip that changes while you are
 *    reading it is the version that reads as noise. `pickTip` is deterministic in its
 *    inputs, so the same key yields the same tip across every re-render; a new chat is a
 *    new key and may yield a different one.
 *  - **Not on every eligible moment.** A line that is always there stops being read and
 *    becomes furniture. `SHOW_PROBABILITY` is applied per key, not per render, so the
 *    decision is stable for as long as the tip would have been.
 *  - **Context-gated.** A tip must never advertise something that will not work where the
 *    user is standing. Shortcut rows carry a `scope` for exactly this, and a tip whose
 *    requirement is unmet is dropped from the pool rather than shown with a caveat.
 *
 * Shortcut tips take their chord from `lib/shortcuts.ts` — the same table the conformance
 * test dispatches against — so a tip cannot name a key the app does not listen for.
 */

import {
  advertisedShortcuts,
  formatCombo,
  type KeyboardShortcut,
} from "@/lib/shortcuts";

/** Fraction of eligible moments that show a tip. Furniture at 1; invisible at 0. */
export const SHOW_PROBABILITY = 0.66;

/** A tip, ready to render. */
export type ComposerTip = {
  id: string;
  /** Set for a shortcut tip; the component renders the keys distinctly. */
  keys?: string;
  text: string;
};

/** What the caller knows about where the user is standing. */
export type TipContext = {
  /** A workspace chat? Gates the work-mode tip, which no-ops outside one. */
  inWorkspaceChat: boolean;
  /** Two or more right-panel tabs? Gates the panel-tab tips, which no-op below two. */
  hasMultiplePanelTabs: boolean;
  isMac: boolean;
};

/**
 * Which shortcut rows may be offered here.
 *
 * Scope strings in the table are human-readable prose for Help, so they are NOT parsed —
 * the mapping from a row to its precondition is explicit, and a row with a scope this
 * function does not recognise is EXCLUDED. Failing closed matters: the alternative is
 * advertising a chord that silently does nothing, which is the one outcome worse than
 * showing no tip.
 */
function shortcutIsUsableHere(s: KeyboardShortcut, ctx: TipContext): boolean {
  switch (s.id) {
    case "cycle-work-mode":
      return ctx.inWorkspaceChat;
    case "prev-panel-tab":
    case "next-panel-tab":
      return ctx.hasMultiplePanelTabs;
    default:
      return !s.scope;
  }
}

/** Ids of the feature tips, in catalog order. Prose lives in the `tips` catalog. */
export const FEATURE_TIP_IDS = [
  "memory",
  "sessionRecall",
  "previousSession",
  "autocomplete",
  "mcp",
  "skills",
  "voice",
  "automations",
  "subagents",
  "editor",
  "terminal",
] as const;

/**
 * The feature-tip ids as a literal union.
 *
 * Exported so the translator callback can be typed with it rather than with `string`.
 * That is not decoration: `t()` is typed against the catalog, so a widened `string` key
 * fails to compile — and keeping the union means a tip id with no catalog entry is a
 * TYPE error rather than a blank line under someone's composer.
 */
export type FeatureTipId = (typeof FEATURE_TIP_IDS)[number];

export type TipTranslator = {
  /** Shortcut action, lower-case and imperative — `tips:shortcuts.<id>`. */
  shortcutAction: (id: string, fallback: string) => string;
  /** Feature prose — `tips:feature.<id>`. */
  feature: (id: FeatureTipId) => string;
};

/** Everything eligible right now, in a stable order. */
export function buildTipPool(ctx: TipContext, t: TipTranslator): ComposerTip[] {
  const shortcutTips: ComposerTip[] = advertisedShortcuts()
    .filter((s) => shortcutIsUsableHere(s, ctx))
    .map((s) => ({
      id: `shortcut:${s.id}`,
      keys: formatCombo(s.combo, ctx.isMac),
      text: t.shortcutAction(s.id, s.label.toLowerCase()),
    }));

  const featureTips: ComposerTip[] = FEATURE_TIP_IDS.map((id) => ({
    id: `feature:${id}`,
    text: t.feature(id),
  }));

  return [...shortcutTips, ...featureTips];
}

/**
 * A small stable hash, so the same key always picks the same tip.
 *
 * Deliberately not `Math.random()`: the choice has to survive every re-render of the
 * composer, and a random call would re-roll on each one — which is precisely the
 * flickering this policy exists to avoid. FNV-1a, because it is four lines and its
 * distribution is fine for choosing between ~15 items.
 */
function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The tip for this key, or null when this key draws a blank.
 *
 * `key` should change when it is legitimate for the tip to change — a new app launch, a
 * new chat — and never otherwise. Two independent draws from one hash: the show/hide
 * decision and the choice, so the hidden case is stable too rather than re-rolling into
 * visibility on the next render.
 */
export function pickTip(
  key: string,
  pool: ComposerTip[],
  showProbability = SHOW_PROBABILITY,
): ComposerTip | null {
  if (pool.length === 0) return null;
  const h = hashKey(key);
  // Low 16 bits decide whether to show; high bits choose. Splitting them keeps the two
  // decisions independent, so a key that hides does not correlate with a particular tip.
  const showRoll = (h & 0xffff) / 0x10000;
  if (showRoll >= showProbability) return null;
  const index = (h >>> 16) % pool.length;
  return pool[index] ?? null;
}
