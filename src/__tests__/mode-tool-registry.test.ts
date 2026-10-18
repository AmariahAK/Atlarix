import { describe, expect, it } from "vitest";
import {
  renderActiveModeToolsRegistry,
  filterToolsForActiveMode,
  isToolAllowedInMode,
  getModeToolAllowlist,
  MODE_SYSTEM_TOOL_LISTS,
} from "../lib/tools/mode-tool-registry";
import { isCoreTool } from "../lib/tools/ToolManifest";

describe("mode-tool-registry", () => {
  it("renderActiveModeToolsRegistry(ask) includes mcp_call and not write_file", () => {
    const block = renderActiveModeToolsRegistry("ask", { workspace: true });
    expect(block).toContain("mcp_call");
    expect(block).not.toMatch(/\bwrite_file\b/);
    expect(block).toContain('<tools_registry mode="ask" label="Explore">');
    expect(block).toContain("Enabled MCP servers:");
  });

  it("filterToolsForActiveMode excludes plan-only tools when mode is ask", () => {
    const loaded = new Set(["write_implementation_plan", "read_file"]);
    const tools = [
      { name: "write_implementation_plan" },
      { name: "read_file" },
    ];
    const filtered = filterToolsForActiveMode(tools, {
      loaded,
      hasWorkspace: false,
      mode: "ask",
      isCore: isCoreTool as (t: { name: string }) => boolean,
    });
    expect(filtered.map((t) => t.name)).toEqual(["read_file"]);
  });

  it("union of plan+debug tools is not all allowed in ask", () => {
    expect(isToolAllowedInMode("plan", "plan")).toBe(true);
    expect(isToolAllowedInMode("plan", "ask")).toBe(false);
    expect(isToolAllowedInMode("write_file", "debug")).toBe(true);
    expect(isToolAllowedInMode("write_file", "ask")).toBe(false);
  });

  it("ask allowlist includes the task sub-agent tool but not cross-mode registry lookup", () => {
    const ask = getModeToolAllowlist("ask");
    expect(ask).toContain("task");
    expect(ask).not.toContain("get_mode_tool_registry");
  });

  it("plan cannot EDIT, but can run commands to check its assumptions", () => {
    // No file-writing tool. This is what "Plan does not implement" now rests on
    // — the mode has no edit_file, and a write-shaped COMMAND is routed to the
    // approval queue by the gate (`mutating-commands.ts`) rather than by an
    // allowlist that also blocks `git log`.
    expect(isToolAllowedInMode("write_file", "plan")).toBe(false);
    expect(isToolAllowedInMode("edit_file", "plan")).toBe(false);
    expect(MODE_SYSTEM_TOOL_LISTS.plan).not.toContain("write_file");
    expect(MODE_SYSTEM_TOOL_LISTS.plan).not.toContain("edit_file");

    // Commands ARE allowed. Plan was expected to produce an informed plan while
    // unable to run `git log` or a typecheck, so it inferred what it could have
    // checked. `background_jobs` comes with it because a foreground command
    // auto-promotes after ~15s and its output would otherwise be lost.
    expect(isToolAllowedInMode("run_command", "plan")).toBe(true);
    expect(isToolAllowedInMode("background_jobs", "plan")).toBe(true);
    expect(MODE_SYSTEM_TOOL_LISTS.plan).toContain("run_command");
    expect(MODE_SYSTEM_TOOL_LISTS.plan).toContain("background_jobs");

    // Still able to author the plan + read the workspace.
    expect(isToolAllowedInMode("plan", "plan")).toBe(true);
    expect(isToolAllowedInMode("read_file", "plan")).toBe(true);

    // What paid for them: both are ACTS, and a plan describes acts.
    expect(isToolAllowedInMode("automations", "plan")).toBe(false);
    expect(isToolAllowedInMode("manage_mcp_server", "plan")).toBe(false);
    // …but Plan can still SEE what MCP servers exist, to plan around them.
    expect(isToolAllowedInMode("list_available_mcps", "plan")).toBe(true);
    expect(isToolAllowedInMode("mcp_call", "plan")).toBe(true);
  });

  it("MODE_SYSTEM_TOOL_LISTS.ask is alphabetically sorted", () => {
    const tools = [...MODE_SYSTEM_TOOL_LISTS.ask];
    expect(tools).toEqual([...tools].sort((a, b) => a.localeCompare(b)));
  });
});
