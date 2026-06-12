import { getDefaultStore } from "jotai";
import { pendingSettingsScrollAtom } from "@/atoms/viewAtoms";
import { router } from "@/router";

/**
 * Open Settings and scroll to a specific section (e.g. "ai", "mcp").
 *
 * Sets a one-shot scroll target, then navigates to /settings; SettingsPage
 * consumes the target on mount and scrolls the section into view. This is the
 * reliable cross-page deep-link (navigating then calling scrollIntoView directly
 * races the page mount — the element may not exist yet).
 */
export function openSettingsSection(sectionId: string): void {
  getDefaultStore().set(pendingSettingsScrollAtom, sectionId);
  void router.navigate({ to: "/settings" });
}
