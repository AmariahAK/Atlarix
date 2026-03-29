import { atom } from "jotai";

export const isPreviewOpenAtom = atom(true);
export const selectedFileAtom = atom<{
  path: string;
} | null>(null);
export const activeSettingsSectionAtom = atom<string | null>(
  "general-settings",
);

/** Extension IDs currently added to the left panel (max 5). */
export const activeExtensionIdsAtom = atom<string[]>([]);
/** Currently selected extension tab in the left panel. */
export const selectedExtensionIdAtom = atom<string | null>(null);

/** When true, show onboarding overlay (e.g. after "Restart guide" in Settings). */
export const showOnboardingAtom = atom(false);

/** Current onboarding step: 1 = login, 2 = start with Compass, 3 = BYOK in Settings, null = done / idle. */
export type OnboardingStep = 1 | 2 | 3 | null;
export const onboardingStepAtom = atom<OnboardingStep>(null);

/** Incremented after a Compass chat turn completes so usage hooks can refetch. */
export const compassUsageBumpAtom = atom(0);
