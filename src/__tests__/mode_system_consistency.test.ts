/**
 * PASS6: Keep `<mode_system>` tool lists in sync with `modeAllowlist` in
 * `src/ipc/handlers/chat_stream_handlers.ts` (see MODE_SYSTEM_TOOL_LISTS).
 */
import { describe, expect, it } from "vitest";
import { MODE_SYSTEM_TOOL_LISTS } from "../prompts/system_prompt";
import { ToolRegistry } from "../lib/tools/registry";
import "../lib/tools";

/**
 * Mirror of `modeAllowlist` in chat_stream_handlers.ts (non-build modes).
 * PASS8 B2: `get_workspace_overview` removed — it was advertised here and in
 * MODE_SYSTEM_TOOL_LISTS but never registered in src/lib/tools/.
 */
const STREAM_HANDLER_ALLOWLIST: Record<"ask" | "plan" | "debug" | "review", string[]> = {
  ask: [
    "ask_user",
    "compress_context",
    "deep_research",
    "explore_folder",
    "find_file",
    "get_active_skills",
    "get_blueprint",
    "get_diagram",
    "get_file_outline",
    "get_project_history",
    "get_project_structure",
    "get_repo_overview",
    "list_attachments",
    "list_available_mcps",
    "list_files",
    "list_installed_skills",
    "memory",
    "read_attachment",
    "read_file",
    "read_url",
    "run_command",
    "search",
    "web_search",
  ],
  plan: [
    "ask_user",
    "compress_context",
    "edit_file",
    "explore_folder",
    "find_file",
    "get_active_skills",
    "get_blueprint",
    "get_diagram",
    "get_file_outline",
    "get_plan_scope",
    "get_project_history",
    "get_project_structure",
    "get_repo_overview",
    "list_available_mcps",
    "list_files",
    "list_installed_skills",
    "memory",
    "read_file",
    "read_implementation_plan",
    "run_command",
    "search",
    "write_file",
    "write_implementation_plan",
  ],
  debug: [
    "ask_user",
    "diagnose_issue",
    "edit_file",
    "explore_folder",
    "find_file",
    "get_active_skills",
    "get_blueprint",
    "get_diagram",
    "get_file_outline",
    "get_project_structure",
    "get_repo_overview",
    "list_available_mcps",
    "list_files",
    "lsp_definitions",
    "lsp_diagnostics",
    "lsp_hover",
    "lsp_references",
    "mcp_call",
    "memory",
    "read_file",
    "run_command",
    "search",
    "stream_terminal_output",
    "write_file",
  ],
  review: [
    "ask_user",
    "diagnose_issue",
    "explore_folder",
    "find_file",
    "get_active_skills",
    "get_blueprint",
    "get_diagram",
    "get_file_outline",
    "get_project_history",
    "get_project_structure",
    "get_repo_overview",
    "list_available_mcps",
    "list_files",
    "list_installed_skills",
    "lsp_definitions",
    "lsp_diagnostics",
    "lsp_hover",
    "lsp_references",
    "memory",
    "read_file",
    "run_command",
    "search",
  ],
};

function sortNames(names: readonly string[]): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

describe("mode system consistency", () => {
  for (const mode of ["ask", "plan", "debug", "review"] as const) {
    it(`MODE_SYSTEM_TOOL_LISTS.${mode} matches stream handler allowlist`, () => {
      expect(sortNames(MODE_SYSTEM_TOOL_LISTS[mode])).toEqual(sortNames(STREAM_HANDLER_ALLOWLIST[mode]));
    });

    it(`MODE_SYSTEM_TOOL_LISTS.${mode} is alphabetically sorted`, () => {
      const tools = [...MODE_SYSTEM_TOOL_LISTS[mode]];
      expect(tools).toEqual(sortNames(tools));
    });
  }

  it("run_command is offered in Ask-mode tool discovery (allowInAskMode)", () => {
    const askNames = ToolRegistry.getToolsForAskMode().map((t) => t.name);
    expect(askNames).toContain("run_command");
  });

  it("debug mode allowlist includes write_file", () => {
    expect(STREAM_HANDLER_ALLOWLIST.debug).toContain("write_file");
    expect(MODE_SYSTEM_TOOL_LISTS.debug).toContain("write_file");
  });
});
