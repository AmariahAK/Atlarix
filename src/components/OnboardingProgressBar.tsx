/**
 * Onboarding progress bar — step 1: "Sign in to get started"; steps 2–6: "Step X of 5". Includes "Skip all".
 */

import { useAtomValue, useSetAtom } from "jotai";
import { onboardingStepAtom } from "@/atoms/viewAtoms";
import { Button } from "@/components/ui/button";
import { useNavigate } from "@tanstack/react-router";

const STEP_TO_LABEL: Record<number, number> = {
  2: 1,
  3: 2,
  4: 3,
  5: 4,
  6: 5,
};

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
    setStep(null);
    navigate({ to: "/" });
  };

  if (step === null) return null;

  const isLoginStep = step === 1;
  const label = STEP_TO_LABEL[step] ?? 1;

  return (
    <div className="fixed top-0 left-0 right-0 z-[9990] flex items-center justify-between gap-4 px-4 pt-8 pb-2 bg-muted/90 backdrop-blur border-b border-border text-sm">
      {isLoginStep ? (
        <span className="font-medium text-foreground">
          Sign in to get started
        </span>
      ) : (
        <span className="font-medium text-foreground">
          Step {label} of 5
        </span>
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
        <Button variant="ghost" size="sm" onClick={handleSkipAll} className="text-muted-foreground hover:text-foreground">
          Skip all
        </Button>
      </div>
    </div>
  );
}
