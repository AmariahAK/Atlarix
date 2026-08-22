/**
 * Work mode (Ask / Plan / Build / Debug / Review) ↔ chat-mode helpers.
 *
 * Pass 7: Blueprint injection-tier helper removed with the Blueprint subsystem.
 */

import type { WorkMode } from "@/lib/schemas";

/**
 * Persisted ask/build label for the settings row.
 *
 * NO LONGER decides which turn runner a mode gets. It used to, via
 * `settings.selectedChatMode === "ask"` in `chat_stream_handlers`, and that sent
 * **debug** to the ask branch (single round, no completion gates) even though debug
 * is a write mode with the full tool surface. The selector now asks
 * `isReadOnlyWorkMode(effectiveWorkMode)` directly. Keep this in sync if you add a
 * mode, but do not reintroduce it as a routing input — one source of truth.
 */
export function chatModeForWorkMode(mode: WorkMode): "ask" | "build" {
  return mode === "build" ? "build" : "ask";
}

/**
 * Read-only work modes (Explore / Plan / Review + legacy Ask) — the workspace
 * source is NOT writable; only Build/Debug authorize mutation. Drives the
 * read-only run_command sandbox profile (writes to source fail at the OS layer).
 */
export function isReadOnlyWorkMode(mode: WorkMode): boolean {
  return mode !== "build" && mode !== "debug";
}

/** Tool handler chatMode (file write gates, plan/debug rules). */
export function toolExecutionChatMode(
  workMode: WorkMode,
): "ask" | "plan" | "build" | "debug" {
  if (workMode === "plan") return "plan";
  if (workMode === "build") return "build";
  if (workMode === "debug") return "debug";
  return "ask";
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
 * - Manual UI selection (Explore / Plan / Build / Debug / Review): uses `workModePreference` (all five).
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
      return "Debug";
    case "review":
      return "Review";
  }
}
