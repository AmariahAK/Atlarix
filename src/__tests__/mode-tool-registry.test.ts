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
    expect(block).toContain("Workspace chat:");
    expect(block).toContain("Progressive reveal");
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
    expect(isToolAllowedInMode("write_implementation_plan", "plan")).toBe(true);
    expect(isToolAllowedInMode("write_implementation_plan", "ask")).toBe(false);
    expect(isToolAllowedInMode("write_file", "debug")).toBe(true);
    expect(isToolAllowedInMode("write_file", "ask")).toBe(false);
  });

  it("ask allowlist includes delegation tools but not cross-mode registry lookup", () => {
    const ask = getModeToolAllowlist("ask");
    expect(ask).toContain("delegate_to_agent");
    expect(ask).toContain("spawn_sub_agent");
    expect(ask).toContain("task");
    expect(ask).not.toContain("get_mode_tool_registry");
  });

  it("plan mode is filesystem read-only but keeps plan-artifact tools", () => {
    // Must NOT be able to mutate the workspace or run shell.
    expect(isToolAllowedInMode("write_file", "plan")).toBe(false);
    expect(isToolAllowedInMode("edit_file", "plan")).toBe(false);
    expect(isToolAllowedInMode("run_command", "plan")).toBe(false);
    // Must still be able to author the plan + read the workspace.
    expect(isToolAllowedInMode("write_implementation_plan", "plan")).toBe(true);
    expect(isToolAllowedInMode("update_plan_step", "plan")).toBe(true);
    expect(isToolAllowedInMode("read_file", "plan")).toBe(true);
    // And the advertised system tool list must not name them.
    expect(MODE_SYSTEM_TOOL_LISTS.plan).not.toContain("write_file");
    expect(MODE_SYSTEM_TOOL_LISTS.plan).not.toContain("run_command");
  });

  it("MODE_SYSTEM_TOOL_LISTS.ask is alphabetically sorted", () => {
    const tools = [...MODE_SYSTEM_TOOL_LISTS.ask];
    expect(tools).toEqual([...tools].sort((a, b) => a.localeCompare(b)));
  });
});
