/**
 * request_mode_change: Let the model switch between any WorkMode (Ask / Plan / Build / Debug / Review).
 * All valid transitions apply immediately via settings (no confirmation). In Auto intent mode, switches
 * keep intentMode as "auto" while updating work mode fields.
 */

import {
  ToolRegistry,
  ToolCategory,
  createParameters,
  stringParam,
} from "./registry";
import { writeSettings } from "../../main/settings";
import { settingsPatchForWorkMode, labelForWorkMode } from "@/lib/work-mode";
import type { WorkMode } from "@/lib/schemas";

function modeChangeAckMessage(modeLabel: string): string {
  return `Mode switched to ${modeLabel}. Continue with the user's request in this mode.`;
}

const ALL_MODES = ["ask", "plan", "build", "debug", "review"] as const;
type ToolMode = (typeof ALL_MODES)[number];

type ModeChangeArgs = {
  mode: ToolMode;
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
    "Switch between work modes: Ask (read-only), Plan (read + plan writing), Build (write/run), Debug (diagnostic tools), Review (code review). Valid switches apply immediately. In Auto intent mode, the app stays in Auto while updating the active work mode.",
  category: ToolCategory.TASK,
  cost: 0,
  requiresWorkspace: false,
  isCore: false,
  isReadOnly: true,
  parameters: createParameters(
    {
      mode: {
        type: "string",
        enum: [...ALL_MODES],
        description:
          "Target mode: 'ask' (read-only), 'plan' (read + plan writing), 'build' (write/run), 'debug' (diagnostics), 'review' (code review).",
      },
      reason: stringParam("Short reason for the switch (e.g. 'User asked to implement the feature')."),
    },
    ["mode", "reason"]
  ),
  handler: async (args: ModeChangeArgs): Promise<Record<string, unknown>> => {
    const mode = args.mode as ToolMode;
    const reason = String(args.reason ?? "");
    const hasWorkspace = args.hasWorkspace === true;
    const currentMode = (args.currentMode ?? "build") as "ask" | "build";
    const intentMode = (args.intentMode ?? "ask") as "ask" | "build" | "auto";
    const hasPendingPermissions = args.hasPendingPermissions === true;

    const workMode = mode as WorkMode;
    const patch = settingsPatchForWorkMode(workMode);
    const label = labelForWorkMode(workMode);

    if (mode === currentMode) {
      return { success: true, message: "Already in that mode." };
    }

    if (!hasWorkspace && mode !== "ask") {
      return {
        success: false,
        error:
          "Cannot switch to this mode without a workspace. Please select a workspace first.",
      };
    }

    if (hasPendingPermissions) {
      return {
        success: false,
        error: "Complete or cancel current changes first.",
      };
    }

    // Auto intent: apply any switch and keep intent in Auto
    if (intentMode === "auto") {
      writeSettings({ ...patch, intentMode: "auto" });
      return {
        success: true,
        message: modeChangeAckMessage(label),
        __emit_mode_change_activity: true,
        requestedMode: mode,
        reason,
      };
    }

    writeSettings(patch);
    return { success: true, message: modeChangeAckMessage(label), requestedMode: mode, reason };
  },
});
