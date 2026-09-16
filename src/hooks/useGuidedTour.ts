/**
 * Drives the guided tour: which step is showing, and how it ends.
 *
 * ONE HOOK, MANY ANCHORS. Every anchored control calls this and asks "is my step the
 * live one?". The step index lives in a jotai atom because the three anchors sit in
 * two different components with no useful common parent — see `onboardingTourAtoms`
 * for why that beats the `querySelector`-on-`data-tour` approach this replaced.
 *
 * ENDING IS ONE PATH, NOT FOUR. Finishing the last step, pressing Skip, Esc, and
 * clicking the backdrop all land on `end()`, which clears the atom AND records the
 * tour as seen. An earlier version of this idea recorded completion only on the last
 * "Done", so anyone who dismissed step 1 got the whole thing again on next launch —
 * the exact behaviour that makes people distrust onboarding.
 */

import { useCallback, useEffect, useState } from "react";
import { useAtom } from "jotai";

import { guidedTourStepAtom } from "@/atoms/onboardingTourAtoms";
import {
  GUIDED_TOUR_ID,
  GUIDED_TOUR_STEPS,
  type GuidedTourStep,
} from "@/lib/onboarding/guided-tour";
import {
  hintWasSeen,
  markHintSeen,
  readHintState,
} from "@/lib/onboarding/hint-state";

export interface GuidedTourState {
  /** True when THIS step is the live one. */
  isStepActive: (id: GuidedTourStep["id"]) => boolean;
  stepIndex: number | null;
  stepCount: number;
  next: () => void;
  end: () => void;
  /** Begin at step 0 — only if the user has not already been through it. */
  start: () => void;
  /** Null until the persisted record has been read. */
  alreadySeen: boolean | null;
}

export function useGuidedTour(): GuidedTourState {
  const [stepIndex, setStepIndex] = useAtom(guidedTourStepAtom);
  const [alreadySeen, setAlreadySeen] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const state = await readHintState();
      if (!cancelled) setAlreadySeen(hintWasSeen(state, GUIDED_TOUR_ID));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const end = useCallback(() => {
    setStepIndex(null);
    setAlreadySeen(true);
    void markHintSeen(GUIDED_TOUR_ID);
  }, [setStepIndex]);

  const next = useCallback(() => {
    setStepIndex((cur) => {
      if (cur === null) return null;
      const following = cur + 1;
      if (following >= GUIDED_TOUR_STEPS.length) {
        // Last step: fall through to `end()` semantics without a second click.
        setAlreadySeen(true);
        void markHintSeen(GUIDED_TOUR_ID);
        return null;
      }
      return following;
    });
  }, [setStepIndex]);

  const start = useCallback(() => {
    if (alreadySeen) return;
    setStepIndex(0);
  }, [alreadySeen, setStepIndex]);

  const isStepActive = useCallback(
    (id: GuidedTourStep["id"]) =>
      stepIndex !== null && GUIDED_TOUR_STEPS[stepIndex]?.id === id,
    [stepIndex],
  );

  return {
    isStepActive,
    stepIndex,
    stepCount: GUIDED_TOUR_STEPS.length,
    next,
    end,
    start,
    alreadySeen,
  };
}
