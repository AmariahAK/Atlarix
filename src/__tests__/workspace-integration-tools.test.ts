import { describe, expect, it } from "vitest";
import {
  WORKSPACE_INTEGRATION_TOOL_NAMES,
  isWorkspaceIntegrationTool,
  isCoreTool,
} from "../lib/tools/ToolManifest";
import { ToolRegistry } from "../lib/tools/registry";
import "../lib/tools";

describe("workspace integration tools", () => {
  it("defines the MCP tools available in any workspace chat", () => {
    // An exact array on purpose: this list is what gets offered without being
    // "loaded", so a tool arriving here should be a deliberate edit, not a side
    // effect of registering something.
    expect(WORKSPACE_INTEGRATION_TOOL_NAMES).toEqual([
      "list_available_mcps",
      "mcp_call",
      // v14.45: propose add/edit/delete. Writes nothing itself — every operation
      // returns a permission envelope and the user approves a card.
      "manage_mcp_server",
    ]);
  });

  it("isWorkspaceIntegrationTool matches registry names", () => {
    for (const name of WORKSPACE_INTEGRATION_TOOL_NAMES) {
      expect(isWorkspaceIntegrationTool(name)).toBe(true);
      expect(ToolRegistry.get(name)).toBeDefined();
    }
    expect(isWorkspaceIntegrationTool("read_file")).toBe(false);
  });

  it("mcp_call is discoverable in Ask mode via allowInAskMode", () => {
    const askNames = ToolRegistry.getToolsForAskMode().map((t) => t.name);
    expect(askNames).toContain("mcp_call");
    expect(askNames).toContain("list_available_mcps");
    // Not a workspace mutation, and the approval card is the control — the same
    // reasoning that puts `automations` outside Build.
    expect(askNames).toContain("manage_mcp_server");
  });

  it("workspace filter includes integration tools when not core", () => {
    const meta = ToolRegistry.get("list_available_mcps")!;
    expect(isCoreTool(meta)).toBe(false);
    const hasWorkspace = true;
    const loaded = new Set<string>();
    const include =
      loaded.has(meta.name) ||
      isCoreTool(meta) ||
      (hasWorkspace && isWorkspaceIntegrationTool(meta.name));
    expect(include).toBe(true);
  });
});
