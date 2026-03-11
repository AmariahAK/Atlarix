/**
 * Sets onboarding step to 2 when user is logged in and onboarding is not completed.
 * Listens for oauth-callback-success and on mount (when user is already logged in).
 */

import { useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import { onboardingStepAtom } from "@/atoms/viewAtoms";

export function OnboardingTrigger() {
  const setStep = useSetAtom(onboardingStepAtom);
  const checkedRef = useRef(false);

  useEffect(() => {
    const ipc = window.electron?.ipcRenderer;
    if (!ipc?.invoke) return;

    const checkAndStartOnboarding = async () => {
      try {
        const userResult = await ipc.invoke("auth:get-current-user");
        if (!userResult?.user?.id) return;
        const { completed } = await ipc.invoke("onboarding:get-completed");
        if (!completed) setStep(2);
      } catch {
        // ignore
      }
    };

    const handleOAuthSuccess = () => {
      checkAndStartOnboarding();
    };

    ipc.on?.("oauth-callback-success", handleOAuthSuccess as any);

    // On mount: if already logged in and we haven't checked this session, check onboarding
    if (!checkedRef.current) {
      checkedRef.current = true;
      checkAndStartOnboarding();
    }

    return () => {
      ipc.removeListener?.("oauth-callback-success", handleOAuthSuccess as any);
    };
  }, [setStep]);

  return null;
}
