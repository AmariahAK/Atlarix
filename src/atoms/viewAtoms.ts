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

/** Incremented after a Compass chat turn completes so usage hooks can refetch. */
export const compassUsageBumpAtom = atom(0);

/** Fix: Finding 5 — inline quota milestone message (dismiss clears; thresholds fire once per session). */
export const compassMilestoneBannerAtom = atom<string | null>(null);
