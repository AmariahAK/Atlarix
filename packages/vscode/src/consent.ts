/**
 * Usage analytics, asked once in the editor. The setting is the app's and the
 * CLI's (`telemetryConsent`), so one answer anywhere covers all three, and an
 * answer given in the app is never asked again here. No vscode import, so the
 * rule and the words are tested on their own.
 *
 * The words are the app's (AnalyticsConsentModal.tsx) and the CLI's
 * (`/analytics`); the three must not drift.
 */

export const CONSENT_ASKED_KEY = "atlarix.analyticsConsentAsked";

export const CONSENT_QUESTION =
  "Help improve Atlarix: share usage data (which features get used, and whether things work)? Never your code, prompts, file names, or file contents.";

export const CONSENT_DETAIL = [
  "Share usage data — which features get used, and whether things work — to help us understand what matters most.",
  "Never your code, prompts, file names, or file contents. Anonymous when signed out. When signed in, it's linked to your account and includes your email and name, so your usage counts once across your devices. Includes your approximate location (country and city), worked out from your connection; the address itself isn't kept.",
  "Crash and error reports are sent separately and are not covered by this choice — they carry stack traces and device info, never your code or prompts.",
  "The same setting as the Atlarix app and CLI: one answer covers all of them.",
].join("\n\n");

export const YES = "Yes, that's fine";
export const NO = "No thanks";
export const DETAILS = "Details";

/**
 * Ask only when nobody has answered anywhere, only once from this editor, and
 * never while the editor's own telemetry is off (then nothing is sent anyway).
 */
export function shouldAskConsent(consent: string, askedHere: boolean, hostTelemetry = true): boolean {
  return hostTelemetry && consent === "unset" && !askedHere;
}

/**
 * What the agent is started with: the editor's telemetry switch (off stops
 * usage analytics and crash reports in the agent), and a failure the editor
 * hit starting it last time, reported once by the run that does start.
 */
export function agentTelemetryEnv(hostTelemetry: boolean, lastHostError?: string): Record<string, string> {
  return {
    ...(hostTelemetry ? {} : { ATLARIX_HOST_TELEMETRY: "off" }),
    ...(hostTelemetry && lastHostError ? { ATLARIX_HOST_LAST_ERROR: lastHostError } : {}),
  };
}

/** Where the last failed start is remembered (a word, never the message). */
export const HOST_ERROR_KEY = "atlarix.lastHostError";

/** A button's label to the setting it stands for; anything else is no answer. */
export function consentFor(pick: string | undefined): "opted_in" | "opted_out" | null {
  if (pick === YES) return "opted_in";
  if (pick === NO) return "opted_out";
  return null;
}
