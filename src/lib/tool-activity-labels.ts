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
  find_file: "Finding files…",
  get_diagram: "Reading diagram…",
  get_blueprint: "Reading Blueprint…",
  get_blueprint_slice: "Reading Blueprint slice…",
  compare_blueprint_to_live: "Comparing Blueprint…",
  git_status: "Checking git status…",
  git_diff: "Reading git diff…",
  git_log: "Reading git history…",
  run_command: "Running command…",
  execute_command: "Running command…",
  stream_terminal_output: "Streaming terminal…",
  stream_pipeline_logs: "Reading pipeline logs…",
  web_search: "Searching the web…",
  deep_search: "Deep search…",
  read_url: "Reading URL…",
  get_plan_scope: "Scoping plan…",
  read_implementation_plan: "Reading plan…",
  write_implementation_plan: "Writing plan…",
  delegate_to_agent: "Delegating to agent…",
  create_workspace: "Creating workspace…",
  generate_code: "Generating code…",
  request_mode_change: "Requesting mode change…",
  request_workspace_permissions: "Workspace permissions…",
  ask_user: "Asking you…",
  get_project_history: "Reading project history…",
  revert_to_snapshot: "Reverting snapshot…",
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
