import { atom } from "jotai";

export const isPreviewOpenAtom = atom(true);
export const selectedFileAtom = atom<{
  path: string;
} | null>(null);
export const activeSettingsSectionAtom = atom<string | null>(
  "general-settings",
);

/**
 * One-shot deep-link target: set to a settings section id (e.g. "ai", "mcp")
 * right before navigating to /settings, then consumed + scrolled-to once on the
 * SettingsPage mount. Distinct from activeSettingsSectionAtom (which is the
 * scroll-position-driven highlight) so a normal settings open never re-jumps.
 */
export const pendingSettingsScrollAtom = atom<string | null>(null);

/** Extension IDs currently added to the left panel (max 5). */
export const activeExtensionIdsAtom = atom<string[]>([]);
/** Currently selected extension tab in the left panel. */
export const selectedExtensionIdAtom = atom<string | null>(null);

/** Incremented after a Compass chat turn completes so usage hooks can refetch. */
export const compassUsageBumpAtom = atom(0);

/** Fix: Finding 5 — inline quota milestone message (dismiss clears; thresholds fire once per session). */
export const compassMilestoneBannerAtom = atom<string | null>(null);
