/**
 * Actionable tool errors (v10)
 * ============================
 * Every failure the model sees should answer three questions:
 *   1. What happened?  2. Why?  3. What should I do next?
 * `read_file`'s structured errors (file-read-errors.ts) are the template.
 * This module supplies per-tool recovery hints that ToolRegistry.execute
 * merges into failures whose message lacks actionable guidance.
 */

/** Default next-step hint per tool, used when a failure message is bare. */
export const TOOL_RECOVERY_HINTS: Record<string, string> = {
  read_file:
    "Use list_files or explore_folder to locate the correct path, or search to find the file by content.",
  write_file:
    "Check the path is workspace-relative and the parent directory exists (create_directory). In Plan mode only .atlarix/atlarix.md and .atlarix/memory.md are writable.",
  edit_file:
    "Re-read the file with read_file first — the target content may have changed. For larger rewrites use write_file.",
  list_files:
    "Try explore_folder on a specific directory, or find_file with a narrower glob pattern.",
  explore_folder:
    "If the path is a file, use read_file. Verify the directory exists with list_files on its parent.",
  find_file:
    "No matches is often an extension or casing issue — try a broader pattern, or use search to find the file by its content.",
  get_file_outline:
    "Use read_file to inspect the file directly; outlines need a parseable source file.",
  search:
    "Try mode: \"text\" with a simpler query, or browse with list_files / explore_folder. For architecture questions use get_blueprint with a focus_path.",
  get_blueprint:
    "Pass a valid focus_path (a folder that exists). Use get_repo_overview or list_files to find one.",
  run_command:
    "If it timed out, pass a larger timeout_ms or split the command. If it needs interaction, add non-interactive flags (e.g. --yes, CI=true).",
  stream_terminal_output:
    "Verify the command id is from a run_command started this turn.",
  delegate_to_agent:
    "Valid agents: research, explore, scout, architect, builder, reviewer, debugger. Pick one and retry.",
  spawn_sub_agent:
    "Check the sub-agent task description and retry; at most 5 sub-agents per turn.",
  mcp_call:
    "Call list_available_mcps first to see connected servers and exact tool names. If authentication failed, the user must Connect/Configure the server in Settings → Tools & MCP.",
  list_available_mcps:
    "MCP servers are configured per workspace in Settings → Tools & MCP.",
  web_search:
    "Retry with a shorter, keyword-style query. If search is unavailable, tell the user they can enable SearxNG (Settings → Search) or a search MCP.",
  deep_research:
    "Narrow the research question, or fall back to a single web_search for a quick fact.",
  read_url:
    "Check the URL is complete (https://…). For paywalled/JS-heavy pages, try web_search for the same content instead.",
  read_attachment:
    "Call list_attachments to see valid attachment ids for this chat.",
  write_implementation_plan:
    "Plans need an active workspace session — ensure a workspace is open. Re-check the plan markdown structure.",
  read_implementation_plan:
    "No plan exists yet in this session — create one with write_implementation_plan.",
  update_plan_status:
    "Use the planId from the active session plan in context (or read_implementation_plan).",
  update_plan_step:
    "Use the planId from the active session plan and a step index from its checklist (read_implementation_plan shows steps).",
  get_project_history:
    "Project history needs an open workspace with prior sessions; it may be empty for new projects.",
  memory:
    "Memory queries need an open workspace. For durable project facts, read .atlarix/memory.md with read_file.",
  lsp_diagnostics:
    "LSP may still be starting or the language may be unsupported — retry once, or use search/read_file to inspect manually.",
  lsp_definitions:
    "Ensure the file path and position are valid; fall back to search for the symbol name.",
  lsp_references:
    "Ensure the file path and position are valid; fall back to search for the symbol name.",
  lsp_hover:
    "Ensure the file path and position are valid; fall back to read_file around that line.",
  diagnose_issue:
    "Provide a concrete error message or failing file; use lsp_diagnostics or run the failing command first to capture one.",
  record_debug_hypothesis:
    "Record a short cause→fix hypothesis string, then make the minimal matching edit.",
};

const ACTION_PATTERN =
  /\b(use|try|call|run|switch to|instead|retry|pass|check|ensure|verify|see)\b/i;

/** True when a failure message already tells the model what to do next. */
export function hasActionableGuidance(message: string | undefined): boolean {
  if (!message) return false;
  return ACTION_PATTERN.test(message);
}

/**
 * Pick the suggestion for a failure: keep the tool's own, else add the
 * per-tool recovery hint when the message lacks guidance.
 */
export function resolveRecoverySuggestion(args: {
  toolName: string;
  message?: string;
  existingSuggestion?: string;
}): string | undefined {
  const existing = args.existingSuggestion?.trim();
  if (existing) return existing;
  if (hasActionableGuidance(args.message)) return undefined;
  return TOOL_RECOVERY_HINTS[args.toolName];
}
