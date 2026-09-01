/**
 * One-time modal on first launch: "Help improve Atlarix" — anonymous usage analytics (opt-in).
 * Yes → telemetryConsent opted_in. No → opted_out. Never show again after choice.
 * Errors (Sentry) are collected regardless.
 */

import { Button } from "./ui/button";
import { useSettings } from "@/hooks/useSettings";

export function AnalyticsConsentModal() {
  const { settings, updateSettings } = useSettings();

  if (settings?.telemetryConsent !== "unset") {
    return null;
  }

  const handleYes = () => {
    updateSettings({ telemetryConsent: "opted_in" });
  };

  const handleNo = () => {
    updateSettings({ telemetryConsent: "opted_out" });
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="analytics-consent-title"
        className="relative z-10 w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl"
      >
        <h2
          id="analytics-consent-title"
          className="text-lg font-semibold text-foreground"
        >
          Help improve Atlarix
        </h2>
        {/* Must match Settings → "Help improve Atlarix" exactly. This modal used
            to promise "no personal info… anonymous" flat out, while Settings
            correctly said signed-in telemetry carries your email and name — two
            different answers to the same question, both shipped.

            SECOND correction, v14.39.1: this offered a choice and then collected
            regardless of the answer. Sentry initialises on DSN presence alone
            (`main.ts`, `renderer.tsx`) and never reads `telemetryConsent`, so
            "No thanks" still sent stack traces, breadcrumbs and 10%-sampled
            performance traces. The owner's call was to keep error reporting and
            SAY so rather than gate it — an undisclosed collection is the part
            that was wrong, not the collection. If either string changes, change
            both; the two drifting apart is how the first correction happened. */}
        <p className="mt-2 text-sm text-muted-foreground">
          Share usage data — which features get used, and whether things work —
          to help us understand what matters most.
        </p>
        <p className="mt-3 text-sm text-foreground">
          Never your code, prompts, file names, or file contents. Anonymous when
          signed out. When signed in, it&apos;s linked to your account and
          includes your email and name, so your usage counts once across your
          devices. You can change this anytime in Settings.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          Crash and error reports are sent separately and are not covered by this choice — they carry stack traces and device info, never your code or prompts.
        </p>
        <div className="mt-6 flex gap-3 justify-end">
          <Button variant="secondary" onClick={handleNo}>
            No thanks
          </Button>
          <Button onClick={handleYes}>Yes, that&apos;s fine</Button>
        </div>
      </div>
    </div>
  );
}
