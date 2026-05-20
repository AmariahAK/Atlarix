/**
 * Stub for the Chromium/renderer Vite bundle only.
 *
 * Main-process code that imports `@sentry/electron/main` is aliased here in
 * `vite.renderer.config.mts` so Node-only Sentry packages never enter the UI bundle.
 */
export function addBreadcrumb(): void {
  /* noop */
}

export function captureException(_error: unknown): void {
  /* noop */
}

export function captureMessage(
  _message: string,
  _captureContext?: unknown,
): void {
  /* noop */
}
