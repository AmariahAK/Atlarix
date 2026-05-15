/**
 * Work mode (Ask / Plan / Build / Debug / Review) ↔ chat-mode helpers.
 *
 * Pass 7: Blueprint injection-tier helper removed with the Blueprint subsystem.
 */

import type { WorkMode } from "@/lib/schemas";

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
