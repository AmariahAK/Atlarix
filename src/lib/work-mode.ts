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

/**
 * Resolved work mode for prompts, tool allowlists, and activity labels.
 * - Manual UI selection (Explore / Plan / Build / Fix / Review): uses `workModePreference` (all five).
 * - Legacy Auto intent: collapses to ask or build from `selectedChatMode` only.
 */
export function resolveEffectiveWorkMode(params: {
  workModeOverride?: WorkMode;
  intentMode?: string | null;
  workModePreference?: WorkMode | null;
  selectedChatMode: "ask" | "build" | "agent";
}): WorkMode {
  if (params.workModeOverride) return params.workModeOverride;

  const chatMode: "ask" | "build" =
    params.selectedChatMode === "agent" || params.selectedChatMode === "build"
      ? "build"
      : "ask";

  const intent = params.intentMode ?? chatMode;
  if (intent !== "auto") {
    return params.workModePreference ?? (chatMode === "build" ? "build" : "ask");
  }
  return chatMode === "build" ? "build" : "ask";
}

export function labelForWorkMode(mode: WorkMode): string {
  switch (mode) {
    case "ask":
      return "Explore";
    case "plan":
      return "Plan";
    case "build":
      return "Build";
    case "debug":
      return "Fix";
    case "review":
      return "Review";
  }
}
