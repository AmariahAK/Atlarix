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
        <p className="mt-2 text-sm text-muted-foreground">
          Share anonymous usage data (no code, no prompts, no personal info) to
          help us understand which features matter most.
        </p>
        <p className="mt-3 text-sm text-foreground">
          Can we collect anonymous usage stats? No code, prompts, or personal
          data — just which features you use. You can change this anytime in
          Settings.
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
