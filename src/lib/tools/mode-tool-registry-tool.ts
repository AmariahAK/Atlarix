/**
 * get_mode_tool_registry — read-only lookup of per-mode tool allowlists.
 */

import { ToolRegistry, ToolCategory, stringParam } from "./registry";
import {
  getModeToolAllowlist,
  type ModeRegistryKey,
} from "./mode-tool-registry";

const MODE_PARAM_VALUES = ["ask", "plan", "build", "debug", "review"] as const;

ToolRegistry.register({
  name: "get_mode_tool_registry",
  category: ToolCategory.TASK,
  cost: 1,
  description:
    "Return the tool allowlist for the current work mode (or an explicit mode if provided). Build-only lookup; not on default Explore allowlist.",
  isReadOnly: true,
  allowInAskMode: true,
  parameters: {
    mode: stringParam("Optional work mode: ask | plan | build | debug | review"),
  },
  handler: async (params: {
    mode?: string;
    _activeWorkMode?: ModeRegistryKey;
  }) => {
    const raw = params.mode?.trim().toLowerCase();
    const active = params._activeWorkMode ?? "build";
    const resolved =
      raw && MODE_PARAM_VALUES.includes(raw as (typeof MODE_PARAM_VALUES)[number])
        ? (raw as ModeRegistryKey)
        : active;
    if (raw && !MODE_PARAM_VALUES.includes(raw as (typeof MODE_PARAM_VALUES)[number])) {
      return {
        error: `Invalid mode "${params.mode}". Use: ${MODE_PARAM_VALUES.join(", ")}`,
      };
    }
    return {
      mode: resolved,
      tools: [...getModeToolAllowlist(resolved)],
    };
  },
});
