/**
 * Stub for the Chromium/renderer Vite bundle only.
 *
 * `registry.ts` is imported from the renderer (e.g. ToolIndicator) and pulls in `guard.ts`,
 * which dynamically imports `@sentry/electron/main`. Resolving that to the real package would
 * drag `@sentry/node` (Node builtins) into the browser bundle and break `electron-forge package`.
 * Main/preload use the real `@sentry/electron/main` via their own Vite configs.
 */
export function addBreadcrumb(): void {
  /* noop in renderer — breadcrumbs are recorded from the main process tool paths */
}
