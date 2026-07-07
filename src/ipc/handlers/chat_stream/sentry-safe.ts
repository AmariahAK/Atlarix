/**
 * Sentry breadcrumb/exception wrappers that never throw — extracted from
 * chat_stream_handlers.ts. Pure leaves, no module state. (Satellite: never
 * imports the parent handler.)
 */

import * as Sentry from "@sentry/electron/main";

export function sentryAddBreadcrumbSafe(
  breadcrumb: Parameters<typeof Sentry.addBreadcrumb>[0],
): void {
  try {
    Sentry.addBreadcrumb(breadcrumb);
  } catch {
    /* noop */
  }
}

export function sentryCaptureExceptionSafe(
  error: unknown,
  captureContext?: Parameters<typeof Sentry.captureException>[1],
): void {
  try {
    Sentry.captureException(error, captureContext);
  } catch {
    /* noop */
  }
}
