import { describe, expect, it } from "vitest";
import {
  WORKSPACE_INTEGRATION_TOOL_NAMES,
  isWorkspaceIntegrationTool,
  isCoreTool,
} from "../lib/tools/ToolManifest";
import { ToolSessionLoader } from "../lib/tools/ToolSessionLoader";
import { ToolRegistry } from "../lib/tools/registry";
import "../lib/tools";

describe("workspace integration tools", () => {
  it("defines four MCP/skills discovery tools", () => {
    expect(WORKSPACE_INTEGRATION_TOOL_NAMES).toEqual([
      "list_available_mcps",
      "mcp_call",
      "list_installed_skills",
      "get_active_skills",
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
    expect(askNames).toContain("get_active_skills");
  });

  it("ToolSessionLoader.ensureLoaded pre-registers integration tools", () => {
    const loader = new ToolSessionLoader((name) => ToolRegistry.get(name));
    const before = loader.getLoadedToolNames();
    for (const name of WORKSPACE_INTEGRATION_TOOL_NAMES) {
      expect(before.has(name)).toBe(false);
    }
    loader.ensureLoaded(WORKSPACE_INTEGRATION_TOOL_NAMES);
    const after = loader.getLoadedToolNames();
    for (const name of WORKSPACE_INTEGRATION_TOOL_NAMES) {
      expect(after.has(name)).toBe(true);
    }
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
