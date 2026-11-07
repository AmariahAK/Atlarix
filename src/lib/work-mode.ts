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
 * The mode the NEXT message will run in, as the composer should show it.
 *
 * ONE rule, in one place, because having two was the bug: `ChatIntentSelector`
 * resolved `session ?? global`, while the footer beside it resolved the global
 * ALONE — it was never updated when sessions gained their own mode in v14.36.0. A
 * session whose mode differed from the global therefore showed one mode in the
 * picker and a different one in the footer, with no way to tell which was in force.
 *
 * Mirrors `resolveEffectiveWorkMode`'s precedence on the main side, which is what
 * actually decides the turn.
 */
export function resolveSelectedWorkMode(params: {
  sessionWorkMode?: WorkMode | null;
  workModePreference?: WorkMode | null;
  selectedChatMode?: "ask" | "build" | "agent" | null;
}): WorkMode {
  if (params.sessionWorkMode) return params.sessionWorkMode;
  if (params.workModePreference) return params.workModePreference;
  const chatMode =
    params.selectedChatMode === "agent"
      ? "build"
      : (params.selectedChatMode ?? "ask");
  return chatMode === "ask" ? "ask" : "build";
}

/**
 * What the composer should DISPLAY as the mode in force.
 *
 * While a turn streams that is the mode the turn was dispatched with — it is fixed
 * for the life of the turn and cannot be retargeted mid-flight, deliberately, so a
 * picker click can never revoke a live turn's write permission. Showing the newly
 * picked mode there would name a mode the turn is not running in.
 *
 * `runningWorkMode` should be passed only while a turn is actually live; a stale
 * value from a finished turn must not be displayed as current.
 */
export function resolveDisplayedWorkMode(params: {
  selected: WorkMode;
  runningWorkMode?: WorkMode | null;
}): WorkMode {
  return params.runningWorkMode ?? params.selected;
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
    return (
      params.workModePreference ?? (chatMode === "build" ? "build" : "ask")
    );
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

/**
 * The write mode an ask_user answer chose, or null.
 *
 * Read-only modes are told to "call ask_user to switch to Build/Debug"
 * (mode-prompt-bundle.ts), so the user's answer to that question IS a mode
 * pick, and every surface applies it before the turn continues (Windows
 * fresh-install QA W4, 2026-11-07). Only an answer that IS the switch counts,
 * the whole of it: "No, don't switch to Build", "Explain why I would switch to
 * Build" and answers that disagree pick nothing. The labels are model-written,
 * so a prefix match let an injected option like "Switch to the build log" make
 * the workspace writable with one click (15.14.0 security gate).
 */
const SWITCH_ANSWER =
  /^\s*(?:yes\b[\s,.!:-]*)?(?:please\s+)?switch\s+to\s+(?:the\s+)?(build|debug)(?:\s+mode)?(?:\s*\(recommended\))?\s*[.!]?\s*$/i;

export function workModeChosenInAnswers(
  answers: readonly string[],
): Extract<WorkMode, "build" | "debug"> | null {
  const picked = new Set<"build" | "debug">();
  for (const a of answers) {
    const m = SWITCH_ANSWER.exec(a ?? "");
    if (m) picked.add(m[1]!.toLowerCase() as "build" | "debug");
  }
  return picked.size === 1 ? [...picked][0]! : null;
}

/**
 * The message that starts building an approved plan — the desktop's Build
 * button and the CLI's "Build it" send the same words.
 */
export const BUILD_FROM_PLAN_PROMPT =
  "Implement the plan in the Plan panel step by step. Follow the phases and items in order.";
