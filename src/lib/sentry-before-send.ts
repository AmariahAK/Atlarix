import type { ErrorEvent, EventHint } from "@sentry/core";

/**
 * Drop expected non-errors so Sentry alerts stay actionable.
 * - Auth required (logged-out users hitting gated features)
 * - Missing project typescript (mitigated by bundled worker TS in current builds)
 */
export function sentryBeforeSendDropExpected(
  event: ErrorEvent,
  hint?: EventHint,
): ErrorEvent | null {
  const parts: string[] = [];
  if (event.message) parts.push(event.message);
  const values = event.exception?.values;
  if (values) {
    for (const ex of values) {
      if (ex.value) parts.push(ex.value);
      if (ex.type) parts.push(ex.type);
    }
  }
  const original = hint?.originalException;
  if (original instanceof Error) {
    parts.push(original.message, original.name);
  } else if (typeof original === "string") {
    parts.push(original);
  }
  const combined = parts.join("\n");

  if (
    combined.includes("ATLARIX_AUTH_REQUIRED") ||
    combined.includes("Please sign in or sign up to use Atlarix.")
  ) {
    return null;
  }
  if (combined.includes("AuthRequiredError")) return null;

  if (
    combined.includes("Failed to load TypeScript from") &&
    combined.includes("Cannot find module 'typescript'")
  ) {
    return null;
  }

  return event;
}
