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

/** Current onboarding step: 1 = login first, 2–6 = workspace/settings flow, null = not in onboarding. */
export type OnboardingStep = 1 | 2 | 3 | 4 | 5 | 6 | null;
export const onboardingStepAtom = atom<OnboardingStep>(null);
