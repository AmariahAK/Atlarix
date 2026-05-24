/**
 * Sets onboarding step to 2 when user is logged in and onboarding is not completed.
 * Listens for oauth-callback-success and on mount (when user is already logged in).
 */

import { useEffect, useRef } from "react";
import { subscribeOAuthSuccess } from "@/lib/auth/auth-ipc-bridge";
import { useSetAtom } from "jotai";
import { onboardingStepAtom } from "@/atoms/viewAtoms";
import { persistOnboardingStep, readPersistedOnboardingStep } from "@/lib/onboarding";

export function OnboardingTrigger() {
  const setStep = useSetAtom(onboardingStepAtom);
  const checkedRef = useRef(false);

  useEffect(() => {
    const ipc = window.electron?.ipcRenderer;
    if (!ipc?.invoke) return;

    const checkAndStartOnboarding = async () => {
      if (localStorage.getItem("atlarix.onboarding_skipped")) return;
      try {
        const userResult = (await ipc.invoke("auth:get-current-user")) as { user?: { id?: string } };
        if (!userResult?.user?.id) {
          setStep(1); // Not logged in: show "Sign in to get started"
          return;
        }
        const result = (await ipc.invoke("onboarding:get-completed")) as { completed?: boolean };
        if (!result?.completed) {
          const persisted = readPersistedOnboardingStep();
          if (persisted === 4 || persisted === 5) {
            setStep(persisted);
          } else {
            setStep(2);
            persistOnboardingStep(2);
          }
        }
      } catch {
        // ignore
      }
    };

    const handleOAuthSuccess = () => {
      checkAndStartOnboarding();
    };

    const unsub = subscribeOAuthSuccess(handleOAuthSuccess);

    // On mount: if already logged in and we haven't checked this session, check onboarding
    if (!checkedRef.current) {
      checkedRef.current = true;
      checkAndStartOnboarding();
    }

    return () => {
      unsub();
    };
  }, [setStep]);

  return null;
}
