/**
 * Work mode (Ask / Plan / Build / Debug / Review) ↔ permission + Blueprint injection tier.
 */

import type { WorkMode } from "@/lib/schemas";

export type BlueprintInjectionTier = "ask" | "plan" | "build" | "debug";

/** Blueprint tier forced from manual work mode (undefined in Auto intent = use heuristics + settings). */
export function blueprintTierForWorkMode(mode: WorkMode): BlueprintInjectionTier | undefined {
  switch (mode) {
    case "ask":
      return "ask";
    case "plan":
      return "plan";
    case "build":
      return "build";
    case "debug":
      return "debug";
    case "review":
      return "ask";
  }
}

/** Persisted ask/build for stream tool path. */
export function chatModeForWorkMode(mode: WorkMode): "ask" | "build" {
  return mode === "build" ? "build" : "ask";
}

/** Apply a manual work mode to settings fields (caller sets intentMode separately for Auto). */
export function settingsPatchForWorkMode(mode: WorkMode): {
  workModePreference: WorkMode;
  selectedChatMode: "ask" | "build";
  intentMode: "ask" | "build";
} {
  return {
    workModePreference: mode,
    selectedChatMode: chatModeForWorkMode(mode),
    intentMode: chatModeForWorkMode(mode),
  };
}

export function labelForWorkMode(mode: WorkMode): string {
  switch (mode) {
    case "ask":
      return "Ask";
    case "plan":
      return "Plan";
    case "build":
      return "Build";
    case "debug":
      return "Debug";
    case "review":
      return "Review";
  }
}
