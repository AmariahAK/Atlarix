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
  get_blueprint: "Code map refreshed…",
  find_file: "Finding files…",
  get_diagram: "Reading diagram…",
  edit_file: "Editing file…",
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
  delegate_to_agent: "Agent team assigned…",
  spawn_sub_agent: "Spawning sub-agent…",
  create_workspace: "Creating workspace…",
  generate_code: "Generating code…",
  ask_user: "Asking you…",
  get_repo_overview: "Mapping repository…",
  get_project_structure: "Reading project layout…",
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

const DONE_LABELS: Record<string, string> = {
  read_file: "Read files",
  write_file: "Wrote file",
  write_multiple_files: "Wrote files",
  delete_file: "Deleted file",
  rename_file: "Renamed file",
  list_files: "Listed files",
  explore_folder: "Explored folder",
  search_code: "Searched codebase",
  search: "Ran codebase search",
  get_blueprint: "Refreshed code map",
  find_file: "Found files",
  get_diagram: "Read diagram",
  edit_file: "Edited file",
  run_command: "Ran command",
  execute_command: "Ran command",
  stream_terminal_output: "Streamed terminal output",
  web_search: "Searched the web",
  deep_research: "Completed deep research",
  read_url: "Read URL",
  diagnose_issue: "Diagnosed issue",
  memory: "Recalled memory",
  list_available_mcps: "Listed MCP servers",
  mcp_call: "Called MCP tool",
  get_active_skills: "Read active skills",
  list_installed_skills: "Listed installed skills",
  get_plan_scope: "Scoped plan",
  read_implementation_plan: "Read plan",
  write_implementation_plan: "Saved plan",
  delegate_to_agent: "Assigned agent team",
  spawn_sub_agent: "Sub-agent finished",
  create_workspace: "Created workspace",
  generate_code: "Generated code",
  ask_user: "Asked you",
  get_repo_overview: "Mapped repository",
  get_project_structure: "Read project layout",
  get_project_history: "Read project history",
  set_project_memory: "Updated project memory",
  get_atlarixignore: "Read ignore rules",
  update_atlarixignore: "Updated ignore rules",
  db_query: "Queried database",
  db_schema: "Read database schema",
  db_list: "Listed database connections",
  db_mutate: "Updated database",
};

/** Past-tense label for completed tool cards. */
export function getToolDoneLabel(toolName: string): string {
  if (!toolName) return "Done";
  if (toolName.includes("__")) {
    const [server, tool] = toolName.split("__").filter(Boolean);
    if (server && tool) {
      return `MCP (${server}): ${tool.replace(/-/g, " ")}`;
    }
  }
  if (DONE_LABELS[toolName]) return DONE_LABELS[toolName];
  if (toolName === "unknown" || toolName === "tool") return "Completed tool";
  const running = getToolActivityLabel(toolName).replace(/…$/u, "");
  if (/ing\b/i.test(running)) {
    return running.replace(/ing\b/i, "ed");
  }
  return running || "Done";
}
