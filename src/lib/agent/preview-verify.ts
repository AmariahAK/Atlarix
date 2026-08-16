/**
 * Runtime failures observed in a browser tab.
 *
 * **This no longer gates anything.** It used to: a build/debug turn could not end
 * while the app was throwing runtime errors. That was removed because the harness
 * cannot tell WHOSE error it is. A frontend on `:5173` calling its own API on
 * `:8080` is one app across two origins; a staging URL is the app under test; an
 * embedded third-party script is not. Any rule we could write is wrong in one
 * direction or the other, and a wrong block costs accuracy — in practice it
 * nagged an agent to "fix" Google's logged-out auth probe returning 401 on a
 * YouTube tab it had opened purely to read.
 *
 * The model is NOTIFIED instead (see `buildRuntimeNotice`) and reads for itself,
 * and the user can route entries to it. What survives here is the failure
 * *classifier*, which still has one legitimate consumer: `browser_test`, where
 * the agent has explicitly asked "run these steps and tell me whether it passed".
 * A verdict the agent requested is not the harness overruling it.
 */
import {
  getBrowserSurfaceErrors,
  resolveBrowserScope,
  type BrowserSurfaceError,
} from "@/ipc/utils/browser_view_manager";

/**
 * Console levels that count as a FAILURE for an explicitly-requested verification
 * run (`browser_test`). Everything else — `log`/`info`/`debug`/`warning` — is
 * output, not a fault: React/Next dev mode emits benign warnings constantly, and
 * the Console tab now captures ordinary logs into the same buffer.
 */
export const FAILURE_CONSOLE_LEVELS: ReadonlySet<string> = new Set(["error"]);

/**
 * Entries that represent a genuine runtime failure, newer than `sinceTs`.
 *
 * Consumed by `browser_test` to decide `passed`. Not a gate — nothing here can
 * end or extend a turn on its own.
 */
export function runtimeFailuresSince(
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
    // A console entry counts only at error level. `level` is optional on the
    // type, so an entry that arrives without one does NOT count — fail open,
    // since a false failure is worse than a missed one for a verdict the agent
    // will act on.
    if (e.type === "console-error") {
      return e.level != null && FAILURE_CONSOLE_LEVELS.has(e.level);
    }
    // load-failed | render-gone | network-failed.
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

/**
 * A POINTER to what the browser recorded during this turn — never the entries
 * themselves.
 *
 * This replaces the old runtime and visual gates. It cannot block, extend, or
 * nudge a turn; it is one line of context the model may act on or ignore, and
 * `browser_inspect` is how it reads the detail if it wants to.
 *
 * Pointer rather than payload for the same reason skills and project memory are
 * indexed rather than inlined: a chatty page would otherwise dump hundreds of
 * lines into every round. It also means the cost of watching a noisy tab is
 * constant.
 *
 * Returns null when nothing was recorded, so a quiet turn adds nothing at all.
 */
export function buildRuntimeNotice(turnId: string): string | null {
  const baseline = previewBaselineByTurn.get(turnId) ?? 0;
  // One turn belongs to one window; no window id is threaded here, so this
  // resolves the focused/only window — correct for the single-window case a turn
  // overwhelmingly runs in.
  const scope = resolveBrowserScope();
  if (!scope) return null;

  const fresh = getBrowserSurfaceErrors(scope).filter(
    (e) => e.timestamp >= baseline && !e.unrelated,
  );
  if (fresh.length === 0) return null;

  const failedRequests = fresh.filter((e) => e.type === "network-failed").length;
  const consoleErrors = fresh.filter(
    (e) => e.type === "console-error" && e.level === "error",
  ).length;
  const other = fresh.length - failedRequests - consoleErrors;

  const parts: string[] = [];
  if (failedRequests > 0) {
    parts.push(`${failedRequests} failed request${failedRequests === 1 ? "" : "s"}`);
  }
  if (consoleErrors > 0) {
    parts.push(`${consoleErrors} console error${consoleErrors === 1 ? "" : "s"}`);
  }
  if (other > 0) parts.push(`${other} other console entr${other === 1 ? "y" : "ies"}`);
  if (parts.length === 0) return null;

  // Deliberately NOT phrased as an instruction. The harness cannot tell whose
  // error this is — the page may be a third-party site the agent opened to read,
  // in which case there is nothing to fix and saying "fix it" wastes a round.
  return (
    `The browser recorded ${parts.join(", ")} during this turn. ` +
    `This is not a verdict — it may be the app you are building, or a page you ` +
    `merely opened. Read them with browser_inspect(mode:"network") or ` +
    `mode:"console") if they are relevant to your task.`
  );
}
