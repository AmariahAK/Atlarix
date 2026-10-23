/**
 * Whether the user opted in to analytics, as the window knows it. A leaf module:
 * posthog-client reads it, and useSettings (which keeps it in step with
 * settings.json) imports posthog-client, so it cannot live in either.
 */

// localStorage mirrors settings.json, which is the source of truth for consent.
// The fork-era key names were unlinked on every settings load for many releases, so
// that migration has already run everywhere; a stale one now simply reads as "no
// consent", which fails closed.
export const TELEMETRY_CONSENT_KEY = "atlarixTelemetryConsent";

export function isTelemetryOptedIn() {
  return window.localStorage.getItem(TELEMETRY_CONSENT_KEY) === "opted_in";
}
