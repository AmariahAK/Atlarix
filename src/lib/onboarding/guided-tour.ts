/**
 * The guided tour: point at the real control, name the real chord, one step at a time.
 *
 * WHY THIS REPLACED "GO AND READ SETTINGS". The wizard's job was to hand the user off
 * to other screens — "Open Settings → AI", "Browse the MCP marketplace" — and that is
 * the wrong shape twice over. It teaches nothing about the window the user is actually
 * going to work in, and it walked them into a dead end: the left rail is
 * `showWorkspaceChrome = selectedAppId != null`, so before a workspace is picked there
 * is no sidebar on ANY route, and Integrations had no back control of its own.
 *
 * THE ANCHORS MUST BE MOUNTED. Each step names a control that lives in the composer
 * row or the right panel, so the tour only runs on the chat screen. A step whose
 * anchor is not rendered simply never opens — which is why the sequence is short and
 * deliberately made of things that are always there, rather than a grand tour of
 * screens that may or may not exist yet.
 *
 * CHORDS COME FROM `lib/shortcuts.ts`. Never a literal: that table is what the
 * conformance test dispatches synthetic events against, so a chord shown here cannot
 * drift from the handler that listens for it. Shift+Tab and ⌘J are the two the owner
 * specifically wanted taught, and they are rows in that table, not strings here.
 */

import { SHORTCUTS, formatCombo, isMacPlatform } from "@/lib/shortcuts";

export interface GuidedTourStep {
  /** Stable id; also the i18n key under `onboarding:tour.<id>`. */
  id: "workModes" | "model";
  /** Row id in `lib/shortcuts.ts` whose chord this step teaches. */
  shortcutId: string;
}

/**
 * Two steps, both anchored in the composer row.
 *
 * A right-panel step was written and dropped: `RightPanel` returns null when hidden,
 * so its anchor does not exist until something opens it, and its root is a flex
 * container that a `Coachmark`'s inline-flex wrapper would visibly break. Teaching a
 * chord for a surface the user cannot see is also the weakest of the three. Adding it
 * back is one entry here plus a `tour.panel` catalog key — but it needs the coachmark
 * to support a non-wrapping anchor first, and that is not this change.
 */
export const GUIDED_TOUR_STEPS: readonly GuidedTourStep[] = [
  { id: "workModes", shortcutId: "cycle-work-mode" },
  { id: "model", shortcutId: "change-model" },
] as const;

export const GUIDED_TOUR_ID = "guided-tour" as const;

/**
 * The chord for a step, formatted for this platform.
 *
 * Returns undefined rather than a placeholder when the row is missing, so a renamed
 * shortcut row degrades to a step with no `kbd` instead of one advertising a key that
 * does not exist.
 */
export function chordForStep(step: GuidedTourStep): string | undefined {
  const row = SHORTCUTS.find((s) => s.id === step.shortcutId);
  return row ? formatCombo(row.combo, isMacPlatform()) : undefined;
}

export function stepIndexById(id: GuidedTourStep["id"]): number {
  return GUIDED_TOUR_STEPS.findIndex((s) => s.id === id);
}
