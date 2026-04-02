/**
 * Onboarding progress — step 1: sign in; steps 2–3: product flow (Compass → Settings for BYOK).
 */

import { useAtomValue, useSetAtom } from "jotai";
import { onboardingStepAtom } from "@/atoms/viewAtoms";
import { persistOnboardingStep } from "@/lib/onboarding";
import { Button } from "@/components/ui/button";
import { useNavigate } from "@tanstack/react-router";

export function OnboardingProgressBar() {
  const step = useAtomValue(onboardingStepAtom);
  const setStep = useSetAtom(onboardingStepAtom);
  const navigate = useNavigate();

  const handleSkipAll = () => {
    localStorage.setItem("atlarix.onboarding_skipped", "1");
    try {
      const ipc = window.electron?.ipcRenderer;
      if (ipc?.invoke) {
        void ipc.invoke("onboarding:set-completed", true);
      }
    } catch {
      // ignore
    }
    persistOnboardingStep(null);
    setStep(null);
    navigate({ to: "/" });
  };

  if (step === null) return null;

  const isLoginStep = step === 1;
  const stepLabel =
    step === 2
      ? "Step 2 of 5 — Start chatting with Compass"
      : step === 3
        ? "Step 3 of 5 — Add your own models in Settings"
        : step === 4
          ? "Step 4 of 5 — How chat continuity works"
          : step === 5
            ? "Step 5 of 5 — Resize the side panel"
            : "";

  return (
    <div className="fixed top-0 left-0 right-0 z-[9990] flex items-center justify-between gap-4 px-4 pt-8 pb-2 bg-muted/90 backdrop-blur border-b border-border text-sm">
      {isLoginStep ? (
        <span className="font-medium text-foreground">
          Step 1 of 5 — Sign in to get started
        </span>
      ) : (
        <span className="font-medium text-foreground">{stepLabel}</span>
      )}
      <div className="flex items-center gap-2">
        {isLoginStep && (
          <Button
            variant="default"
            size="sm"
            onClick={() => navigate({ to: "/sign-in" })}
          >
            Log in / Sign up
          </Button>
        )}
        {step === 5 && (
          <Button
            variant="default"
            size="sm"
            onClick={async () => {
              try {
                const ipc = window.electron?.ipcRenderer;
                if (ipc?.invoke) await ipc.invoke("onboarding:set-completed", true);
              } catch {
                // ignore
              }
              persistOnboardingStep(null);
              setStep(null);
              navigate({ to: "/" });
            }}
          >
            Finish tour
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={handleSkipAll} className="text-muted-foreground hover:text-foreground">
          Skip all
        </Button>
      </div>
    </div>
  );
}
