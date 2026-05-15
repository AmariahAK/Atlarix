/**
 * Human-readable labels for AI tool activity (chat status line).
 * Fix: Finding 4
 */

const LABELS: Record<string, string> = {
  read_file: "Reading files…",
  write_file: "Writing code…",
  write_multiple_files: "Writing files…",
  delete_file: "Deleting file…",
  rename_file: "Renaming file…",
  list_files: "Listing files…",
  explore_folder: "Exploring folder…",
  search_code: "Searching code…",
  search: "Searching codebase…",
  get_blueprint: "Reading Blueprint graph…",
  find_file: "Finding files…",
  get_diagram: "Reading diagram…",
  edit_file: "Editing file…",
  git_status: "Checking git status…",
  git_diff: "Reading git diff…",
  git_log: "Reading git history…",
  run_command: "Running command…",
  execute_command: "Running command…",
  stream_terminal_output: "Streaming terminal…",
  web_search: "Searching the web…",
  deep_research: "Deep research…",
  read_url: "Reading URL…",
  diagnose_issue: "Diagnosing issue…",
  memory: "Recalling memory…",
  list_available_mcps: "Listing MCP servers…",
  mcp_call: "Calling MCP tool…",
  get_active_skills: "Reading active skills…",
  list_installed_skills: "Listing installed skills…",
  // PASS8 B2: get_workspace_overview removed (phantom — never registered).
  get_plan_scope: "Scoping plan…",
  read_implementation_plan: "Reading plan…",
  write_implementation_plan: "Writing plan…",
  delegate_to_agent: "Delegating to agent…",
  create_workspace: "Creating workspace…",
  generate_code: "Generating code…",
  request_mode_change: "Requesting mode change…",
  ask_user: "Asking you…",
  get_project_history: "Reading project history…",
  set_project_memory: "Updating project memory…",
  get_atlarixignore: "Reading ignore rules…",
  update_atlarixignore: "Updating ignore rules…",
  db_query: "Querying database…",
  db_schema: "Reading database schema…",
  db_list: "Listing database connections…",
  db_mutate: "Updating database…",
};

/**
 * Map tool name (including MCP keys like `server__tool`) to a short status string.
 */
export function getToolActivityLabel(toolName: string): string {
  if (!toolName) return "Working…";
  if (toolName.includes("__")) {
    const [server, tool] = toolName.split("__").filter(Boolean);
    if (server && tool) {
      return `MCP (${server}): ${tool.replace(/-/g, " ")}…`;
    }
  }
  return LABELS[toolName] ?? `Running ${toolName.replace(/_/g, " ")}…`;
}
