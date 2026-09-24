/**
 * The shape of one captured console entry — shared by the extension, which
 * records it over CDP (`packages/extension/src/page/cdp-capture.ts`), and the
 * desktop, which renders it for `browser_inspect(mode:"console")`.
 *
 * Dependency-free on purpose: the extension imports it, and an MV3 service
 * worker cannot resolve anything Electron- or Node-shaped.
 *
 * Formerly lived in `error-hook.ts` beside the in-app browser's injected error
 * hook; that hook went with the in-app agent browser in v14.52.0.
 */

/** Console severity. Every level is captured, so an empty read is evidence. */
export type BrowserConsoleLevel =
  | "error"
  | "warning"
  | "info"
  | "log"
  | "debug";

/** A runtime event captured from a browser tab. */
export type BrowserSurfaceError = {
  /**
   * `console-error` predates all-level capture and covers every console level —
   * read it as "console entry"; `level` carries the severity.
   */
  type: "console-error" | "load-failed" | "render-gone" | "network-failed";
  message: string;
  url?: string;
  timestamp: number;
  /** Console severity for `console-error` entries. */
  level?: BrowserConsoleLevel;
  /** HTTP status for `network-failed` entries (>= 400). */
  statusCode?: number;
  /** Stack trace for an uncaught exception — gives the agent a fixable location. */
  stack?: string;
  /** Which browser tab produced this. */
  tabId?: number;
};
