/**
 * `tool_help` — the fetch half of per-mode progressive tool reveal (v14.34).
 *
 * Peripheral tools are bound with one line plus a pointer here; this returns the
 * full registered description on demand. See `tool-reveal.ts` for why the
 * tiering is per mode and why the payload arrives as a tool RESULT rather than
 * by mutating the tools array (the tool definitions sit inside the first prompt
 * cache breakpoint, so growing them mid-session would invalidate the whole
 * cached prefix).
 *
 * Deliberately tiny — this description is bound in every mode, so it is part of
 * the cost it exists to reduce.
 */

import { ToolRegistry, createParameters, stringParam } from "./registry";

ToolRegistry.register({
  name: "tool_help",
  description:
    "Full usage for one tool. Some tools in this mode are bound with a one-line summary and a pointer here — call this with that tool's name to get its complete instructions before using it for the first time. Returns documentation only; it changes nothing.",
  requiresWorkspace: false,
  isCore: true,
  isReadOnly: true,
  allowInAskMode: true,
  parameters: createParameters(
    {
      tool: stringParam(
        'Name of the tool to document, exactly as it appears in your tool list (e.g. "automations").',
      ),
    },
    ["tool"],
  ),
  handler: async (args: { tool?: string }) => {
    const wanted = args.tool?.trim();
    if (!wanted) {
      return {
        success: false,
        error: "Pass `tool` — the name of the tool to document.",
      };
    }
    const meta = ToolRegistry.get(wanted);
    if (!meta) {
      // Name the near-misses rather than failing blind, the same way the other
      // by-name resolvers in the codebase do.
      const needle = wanted.toLowerCase();
      const near = ToolRegistry.getAll()
        .map((t) => t.name)
        .filter(
          (n) =>
            n.toLowerCase().includes(needle) ||
            needle.includes(n.toLowerCase()),
        );
      return {
        success: false,
        error:
          `No tool named "${wanted}".` +
          (near.length > 0 ? ` Did you mean: ${near.join(", ")}?` : ""),
      };
    }
    return {
      success: true,
      tool: meta.name,
      usage: meta.description,
    };
  },
});
