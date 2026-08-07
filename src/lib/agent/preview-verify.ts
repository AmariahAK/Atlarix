/**
 * App runtime-error completion gate (mirrors `mutation-verify.ts`).
 *
 * A build/debug turn must not end "done" while the app (open in a browser tab)
 * is throwing RUNTIME errors — a white-screen, a dead renderer, or API calls
 * returning 4xx/5xx. The agent's prose-only completion gate consults
 * `getPreviewRuntimeFeedback(turnId)`; a non-null result blocks the turn end and
 * nudges a fix (bounded by the same nudge budget that protects the loop).
 *
 * The #1 tuning risk is false positives: React/Next dev mode emits benign
 * `console.warn`/hydration warnings. `blockingPreviewErrors` is the single
 * filter that keeps ONLY genuine failures (error-level console, failed loads,
 * dead renderer, failed network) so the gate can't trap the agent on dev noise.
 */
import {
  getBrowserSurfaceErrors,
  getActiveTabView,
  resolveBrowserScope,
  type BrowserSurfaceError,
} from "@/ipc/utils/browser_view_manager";
import { detectBlankRender } from "@/lib/browser/visual-lint";

/**
 * Keep only preview entries that represent a genuine runtime failure. Drops
 * console *warnings* (dev-mode noise). Optionally restricts to entries newer
 * than a per-turn baseline so pre-existing noise from an earlier turn can't trap
 * the current one.
 */
export function blockingPreviewErrors(
  entries: BrowserSurfaceError[],
  sinceTs = 0,
): BrowserSurfaceError[] {
  return entries.filter((e) => {
    if (e.timestamp < sinceTs) return false;
    // An error from a tab the agent is not working in is not the agent's failure.
    // Errors buffer per WINDOW, so a docs page or dashboard the user has open
    // alongside would otherwise block a turn for a page the agent never touched —
    // the same reason a prior turn's errors are excluded by `sinceTs` above.
    // Still reported to the model, just labelled; see BrowserSurfaceError.unrelated.
    if (e.unrelated) return false;
    if (e.type === "console-error") return e.level === "error";
    // load-failed | render-gone | network-failed are always blocking.
    return true;
  });
}

// ── Per-turn baseline ───────────────────────────────────────────────────────
// Captured at turn start so the gate only reacts to errors observed DURING this
// turn (a preview left broken by a PRIOR turn the user has moved on from must
// not block an unrelated new turn).
const previewBaselineByTurn = new Map<string, number>();

/** Idempotent — keeps the earliest baseline for the turn. */
export function ensurePreviewBaseline(turnId: string, ts: number): void {
  if (turnId && !previewBaselineByTurn.has(turnId)) {
    previewBaselineByTurn.set(turnId, ts);
  }
}

export function clearPreviewBaseline(turnId: string): void {
  previewBaselineByTurn.delete(turnId);
}

const MAX_GATE_ERRORS_SHOWN = 8;

/**
 * Gate feedback: non-null when the live preview currently has blocking runtime
 * errors newer than the turn's baseline; null when clean. Reads the same buffer
 * `browser_inspect(mode:"console")` and `browser_test` read — no extra wiring.
 */
export function getPreviewRuntimeFeedback(turnId: string): string | null {
  const baseline = previewBaselineByTurn.get(turnId) ?? 0;
  // The completion gate runs inside a turn, which belongs to one window. No
  // window id is threaded here, so this resolves the focused/only window — the
  // pre-existing behaviour, and correct for the single-window case that is
  // overwhelmingly what a turn runs in.
  const scope = resolveBrowserScope();
  if (!scope) return null;
  const blocking = blockingPreviewErrors(getBrowserSurfaceErrors(scope), baseline);
  if (blocking.length === 0) return null;
  const lines = blocking
    .slice(0, MAX_GATE_ERRORS_SHOWN)
    .map((e) => `- [${e.type}] ${e.message}`);
  const more =
    blocking.length > MAX_GATE_ERRORS_SHOWN
      ? `\n…and ${blocking.length - MAX_GATE_ERRORS_SHOWN} more.`
      : "";
  return (
    `The app (open in a browser tab) is currently throwing ${blocking.length} runtime ` +
    `error(s) — it's broken (white-screen / failed request / crash):\n` +
    lines.join("\n") +
    more +
    `\nFix the cause and re-verify with browser_test (or browser_inspect ` +
    `mode:"console") before finishing.`
  );
}

/**
 * Visual "renders correctly" gate (v14.8.6) — extends the runtime-error gate
 * from "runs without errors" to "actually renders". Deliberately CONSERVATIVE:
 * blocks "done" ONLY on an unambiguous blank/white-screen (no text, no elements,
 * no media), never on subjective layout/overlap heuristics (that's the agent's
 * job via browser_inspect mode:"visual"). Returns null when there's no preview
 * or it can't tell, so the gate never false-blocks a healthy turn.
 */
export async function getPreviewVisualFeedback(
  _turnId: string,
): Promise<string | null> {
  const scope = resolveBrowserScope();
  const view = scope ? getActiveTabView(scope) : null;
  if (!view) return null;
  const blank = await detectBlankRender(view.webContents);
  if (!blank?.blank) return null;
  return (
    `The app (open in a browser tab) is rendering BLANK (${blank.reason}) — it compiles but ` +
    `shows a white screen. Find why nothing rendered (a crashing root component, an ` +
    `unmounted app, a routing miss) and fix it, then re-check with browser_inspect ` +
    `mode:"visual" before finishing.`
  );
}
