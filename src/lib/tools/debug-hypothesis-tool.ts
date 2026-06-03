/**
 * record_debug_hypothesis — unlocks hypothesis-gated write tools in Debug mode.
 */

import { ToolRegistry, ToolCategory, stringParam } from "./registry";
import { setDebugHypothesis } from "../debug/debug-hypothesis-session";

ToolRegistry.register({
  name: "record_debug_hypothesis",
  category: ToolCategory.CODE,
  description:
    "Record the root-cause hypothesis for this debug session. Required before write_file, edit_file, delete_file, rename_file, or write_multiple_files in Debug mode. State what you believe is broken and why; then apply minimal fixes that test that hypothesis.",
  cost: 1,
  requiresWorkspace: true,
  isReadOnly: true,
  allowInAskMode: false,
  parameters: {
    hypothesis: stringParam(
      "1–3 sentence root-cause hypothesis (what is wrong and why)",
    ),
    likely_files: {
      type: "array",
      items: { type: "string" },
      description: "Files you expect to change to validate the hypothesis",
      required: false,
    },
    evidence: stringParam(
      "Optional: error text, log lines, or observations supporting the hypothesis",
    ),
  },
  handler: async (
    params: {
      hypothesis: string;
      likely_files?: string[];
      evidence?: string;
      _chatSessionId?: number;
    },
  ) => {
    const chatId = params._chatSessionId;
    if (chatId == null || chatId <= 0) {
      return { success: false, error: "Missing chat session for hypothesis record." };
    }
    const hypothesis = params.hypothesis?.trim();
    if (!hypothesis) {
      return { success: false, error: "hypothesis is required." };
    }
    const record = setDebugHypothesis(chatId, {
      hypothesis,
      likelyFiles: Array.isArray(params.likely_files)
        ? params.likely_files.filter((f) => typeof f === "string" && f.trim())
        : [],
      evidence: params.evidence?.trim(),
    });
    return {
      success: true,
      hypothesis: record.hypothesis,
      likely_files: record.likelyFiles,
      message:
        "Hypothesis recorded. You may now use write/edit tools for minimal fixes aligned with this hypothesis. Re-record if the hypothesis changes.",
    };
  },
});
