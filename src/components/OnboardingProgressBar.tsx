/**
 * Onboarding progress bar — shows "Step X of 5" and "Skip all" when in onboarding flow.
 * Rendered in layout when onboardingStepAtom is 2–6.
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

  const handleSkipAll = async () => {
    try {
      const ipc = window.electron?.ipcRenderer;
      if (ipc?.invoke) {
        await ipc.invoke("onboarding:set-completed", true);
      }
    } catch {
      // ignore
    }
    setStep(null);
    navigate({ to: "/" });
  };

  if (step === null) return null;

  const label = STEP_TO_LABEL[step] ?? 1;

  return (
    <div className="fixed top-0 left-0 right-0 z-[9990] flex items-center justify-between gap-4 px-4 py-2 bg-muted/90 backdrop-blur border-b border-border text-sm">
      <span className="font-medium text-foreground">
        Step {label} of 5
      </span>
      <Button variant="ghost" size="sm" onClick={handleSkipAll} className="text-muted-foreground hover:text-foreground">
        Skip all
      </Button>
    </div>
  );
}
