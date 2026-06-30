/**
 * Preview runtime-error completion gate (mirrors `mutation-verify.ts`).
 *
 * A build/debug turn must not end "done" while the live preview is throwing
 * RUNTIME errors — a white-screen, a dead renderer, or API calls returning
 * 4xx/5xx. The agent's prose-only completion gate consults
 * `getPreviewRuntimeFeedback(turnId)`; a non-null result blocks the turn end and
 * nudges a fix (bounded by the same nudge budget that protects the loop).
 *
 * The #1 tuning risk is false positives: React/Next dev mode emits benign
 * `console.warn`/hydration warnings. `blockingPreviewErrors` is the single
 * filter that keeps ONLY genuine failures (error-level console, failed loads,
 * dead renderer, failed network) so the gate can't trap the agent on dev noise.
 */
import {
  getPreviewErrors,
  type PreviewErrorEntry,
} from "@/ipc/utils/browser_view_manager";

/**
 * Keep only preview entries that represent a genuine runtime failure. Drops
 * console *warnings* (dev-mode noise). Optionally restricts to entries newer
 * than a per-turn baseline so pre-existing noise from an earlier turn can't trap
 * the current one.
 */
export function blockingPreviewErrors(
  entries: PreviewErrorEntry[],
  sinceTs = 0,
): PreviewErrorEntry[] {
  return entries.filter((e) => {
    if (e.timestamp < sinceTs) return false;
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
 * `browser_inspect(mode:"console")` and `preview_test` read — no extra wiring.
 */
export function getPreviewRuntimeFeedback(turnId: string): string | null {
  const baseline = previewBaselineByTurn.get(turnId) ?? 0;
  const blocking = blockingPreviewErrors(getPreviewErrors(), baseline);
  if (blocking.length === 0) return null;
  const lines = blocking
    .slice(0, MAX_GATE_ERRORS_SHOWN)
    .map((e) => `- [${e.type}] ${e.message}`);
  const more =
    blocking.length > MAX_GATE_ERRORS_SHOWN
      ? `\n…and ${blocking.length - MAX_GATE_ERRORS_SHOWN} more.`
      : "";
  return (
    `The live preview is currently throwing ${blocking.length} runtime ` +
    `error(s) — the app is broken (white-screen / failed request / crash):\n` +
    lines.join("\n") +
    more +
    `\nFix the cause and re-verify with preview_test (or browser_inspect ` +
    `mode:"console") before finishing.`
  );
}
