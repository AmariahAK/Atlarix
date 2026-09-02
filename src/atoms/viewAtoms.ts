import { atom } from "jotai";

/**
 * DELETED: `activeSettingsSectionAtom` and `pendingSettingsScrollAtom`.
 *
 * Both existed to make a long scrolling Settings page navigable: one held the
 * scroll-spy's current section, the other a one-shot "scroll here after mount"
 * target for deep links. Settings and Integrations are one-section-per-route
 * now, so the router holds that state and `useScrollAndNavigateTo` is gone with
 * them. `openSettingsSection` maps a section id straight to a route.
 */

/** Incremented after a Compass chat turn completes so usage hooks can refetch. */
export const compassUsageBumpAtom = atom(0);

/** Fix: Finding 5 — inline quota milestone message (dismiss clears; thresholds fire once per session). */
export const compassMilestoneBannerAtom = atom<string | null>(null);
