/**
 * Browser-tab runtime error capture: the shared, dependency-free pieces (no
 * electron import) so they can be unit-tested and reused.
 *
 * - BrowserSurfaceError — the captured-error shape.
 * - ERROR_HOOK_SCRIPT — injected into each browser tab to catch uncaught
 *   exceptions / unhandled rejections WITH a stack and relay them back through a
 *   console sentinel (browser tabs have no preload, so the console channel is the
 *   transport).
 * - tryParseErrorSentinel — parses that sentinel back into a structured error.
 */

/**
 * Console severity. `error` and `warning` were the only levels captured until
 * the Console tab; `info` / `log` / `debug` arrive now too, so the panel can be
 * an OBSERVATION feed rather than a failure feed — the agent needs to confirm
 * that something WORKED, not only see that something broke.
 *
 * NOTHING here blocks a turn. Severity decides how an entry is presented and
 * whether it is worth naming in the once-per-turn notice — see
 * `FAILURE_CONSOLE_LEVELS` in `lib/agent/preview-verify.ts`, which is now only a
 * verdict for `browser_test`, not a gate. The harness cannot tell whose error a
 * page reported, so it does not get to end a turn over one.
 */
export type BrowserConsoleLevel = "error" | "warning" | "info" | "log" | "debug";

/** A runtime event captured from a browser-tab surface. */
export type BrowserSurfaceError = {
  /**
   * `console-error` predates all-level capture and now covers every console
   * level — the discriminant is kept because the completion gate keys on it and
   * narrows by `level`, so widening levels needed no change there. Read it as
   * "console entry"; `level` carries the severity.
   */
  type: "console-error" | "load-failed" | "render-gone" | "network-failed";
  message: string;
  url?: string;
  timestamp: number;
  /** Console severity for `console-error` entries. */
  level?: BrowserConsoleLevel;
  /** HTTP status for `network-failed` entries (>= 400). */
  statusCode?: number;
  /** Stack trace for uncaught exceptions / unhandled rejections captured by the
   * injected instrumentation hook — gives the agent a fixable location. */
  stack?: string;
  /** Which browser tab produced this. Errors are buffered per WINDOW, so without
   * this a second tab's errors are indistinguishable from the agent's own. */
  tabId?: number;
  /**
   * True when this error did not come from the tab the agent is working in.
   *
   * The agent's own work happens in ONE tab. Anything the user has open alongside
   * it — a docs page, a dashboard, their own browsing — pushes errors into the same
   * per-window buffer, where they read as the agent's problem: they appeared in
   * `browser_inspect(mode:"console")` and, worse, blocked the completion gate for a
   * page the agent never touched.
   *
   * Mirrors a plan step's `external` state: still visible, explicitly not mine.
   * Unrelated errors are reported to the model LABELLED, and never block a turn.
   */
  unrelated?: boolean;
};

export const ERROR_SENTINEL = "[[ATLARIX_ERR]]";

/**
 * Injected instrumentation (delivered like CLS_OBSERVER_SCRIPT via
 * executeJavaScript on did-finish-load). Hooks window 'error' + 'unhandled
 * rejection' to capture uncaught exceptions/rejections WITH their stack, and
 * relays each back as a `[[ATLARIX_ERR]]` console.error the main process parses.
 * It `preventDefault()`s the native logging so the same error isn't ALSO
 * captured stack-less by the plain console-message path (no double-capture).
 * Failed (4xx/5xx) requests are covered separately by webRequest.onCompleted.
 * Idempotent per document (a window flag guards re-install on re-injection).
 */
export const ERROR_HOOK_SCRIPT = `(() => {
  try {
    if (window.__atlarixErrHook) return;
    window.__atlarixErrHook = true;
    var SENT = ${JSON.stringify(ERROR_SENTINEL)};
    function emit(rec) { try { console.error(SENT + JSON.stringify(rec)); } catch (e) {} }
    window.addEventListener("error", function (e) {
      if (!e || (!e.error && !e.message)) return; // resource-load errors: did-fail-load covers those
      var err = e.error;
      emit({
        type: "console-error", level: "error",
        message: String((err && err.message) || e.message || "Uncaught error"),
        stack: err && err.stack ? String(err.stack).slice(0, 4000) : undefined,
        url: e.filename || undefined,
      });
      if (e.preventDefault) e.preventDefault();
    }, true);
    window.addEventListener("unhandledrejection", function (e) {
      var r = e && e.reason;
      var msg = (r && r.message) ? r.message : (typeof r === "string" ? r : "Unhandled promise rejection");
      emit({
        type: "console-error", level: "error",
        message: "Unhandled rejection: " + String(msg),
        stack: (r && r.stack) ? String(r.stack).slice(0, 4000) : undefined,
      });
      if (e.preventDefault) e.preventDefault();
    });
  } catch (e) { /* never break the page */ }
})();`;

/**
 * Parse a `[[ATLARIX_ERR]]` console message emitted by ERROR_HOOK_SCRIPT into a
 * structured error (without timestamp — the caller stamps it). Returns null for
 * a normal console message so the plain console-error path handles it.
 */
export function tryParseErrorSentinel(
  message: string,
): Omit<BrowserSurfaceError, "timestamp"> | null {
  const idx = message.indexOf(ERROR_SENTINEL);
  if (idx === -1) return null;
  try {
    const rec = JSON.parse(
      message.slice(idx + ERROR_SENTINEL.length).trim(),
    ) as Partial<BrowserSurfaceError>;
    if (!rec || typeof rec.message !== "string") return null;
    return {
      type: (rec.type as BrowserSurfaceError["type"]) || "console-error",
      message: rec.message.slice(0, 4000),
      level: rec.level === "warning" ? "warning" : "error",
      stack: typeof rec.stack === "string" ? rec.stack.slice(0, 4000) : undefined,
      url: typeof rec.url === "string" ? rec.url : undefined,
    };
  } catch {
    return null;
  }
}
