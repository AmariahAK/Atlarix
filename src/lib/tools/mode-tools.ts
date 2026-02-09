/**
 * request_mode_change: Let the model request Ask <-> Build. In Ask mode requires user approval for Build.
 * In Auto mode switches without approval. Build -> Ask can switch directly.
 */

import {
  ToolRegistry,
  ToolCategory,
  createParameters,
  stringParam,
} from "./registry";
import { writeSettings } from "../../main/settings";

type ModeChangeArgs = {
  mode: "ask" | "build";
  reason: string;
  /** Injected by stream handler */
  hasWorkspace?: boolean;
  currentMode?: "ask" | "build";
  intentMode?: "ask" | "build" | "auto";
  hasPendingPermissions?: boolean;
  chatId?: number;
};

ToolRegistry.register({
  name: "request_mode_change",
  description:
    "Request to switch between Ask (read-only) and Build (can write/run) mode. Use when the user wants implementation or code changes but you are in Ask mode (request Build with a reason and wait for approval), or to switch back to Ask when in Build. In Auto mode, switches are applied without user confirmation.",
  category: ToolCategory.TASK,
  cost: 0,
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: true,
  parameters: createParameters(
    {
      mode: {
        type: "string",
        enum: ["ask", "build"],
        description: "Target mode: 'ask' for read-only, 'build' for write/run.",
      },
      reason: stringParam("Short reason for the switch (e.g. 'User asked to implement the feature')."),
    },
    ["mode", "reason"]
  ),
  handler: async (args: ModeChangeArgs): Promise<Record<string, unknown>> => {
    const mode = args.mode as "ask" | "build";
    const reason = String(args.reason ?? "");
    const hasWorkspace = args.hasWorkspace === true;
    const currentMode = (args.currentMode ?? "build") as "ask" | "build";
    const intentMode = (args.intentMode ?? "ask") as "ask" | "build" | "auto";
    const hasPendingPermissions = args.hasPendingPermissions === true;

    if (mode === currentMode) {
      return { success: true, message: "Already in that mode." };
    }

    if (!hasWorkspace && mode === "build") {
      return {
        success: false,
        error:
          "Cannot switch to Build without a workspace. Please select a workspace first.",
      };
    }

    if (hasPendingPermissions) {
      return {
        success: false,
        error: "Complete or cancel current changes first.",
      };
    }

    // Auto mode: apply switch without approval
    if (intentMode === "auto") {
      writeSettings({
        selectedChatMode: mode,
        intentMode: "auto",
      });
      return {
        success: true,
        message: `Switched to ${mode === "build" ? "Build" : "Ask"}.`,
        __emit_mode_change_activity: true,
        requestedMode: mode,
        reason,
      };
    }

    // Build -> Ask: allow direct switch
    if (currentMode === "build" && mode === "ask") {
      writeSettings({
        selectedChatMode: "ask",
        intentMode: "ask",
      });
      return { success: true, message: "Switched to Ask mode." };
    }

    // Ask -> Build: require user approval (stream handler will emit and wait)
    if (currentMode === "ask" && mode === "build") {
      return {
        __mode_change_requested: true,
        requestedMode: "build" as const,
        reason,
      };
    }

    return { success: true, message: "Mode unchanged." };
  },
});
