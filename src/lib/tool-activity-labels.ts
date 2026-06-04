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
  visualize_graph: "Building graph…",
  find_file: "Finding files…",
  get_diagram: "Reading diagram…",
  edit_file: "Editing file…",
  run_command: "Running command…",
  execute_command: "Running command…",
  stream_terminal_output: "Streaming terminal…",
  web_search: "Searching the web…",
  web_search_preview: "Searching the web…",
  google_search: "Searching the web…",
  deep_research: "Deep research…",
  read_url: "Reading URL…",
  diagnose_issue: "Diagnosing issue…",
  record_debug_hypothesis: "Recording debug hypothesis…",
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

/** Arg-aware verbs for the one-line stream status ("Writing src/auth.ts…"). */
const ARG_VERBS: Record<string, string> = {
  read_file: "Reading",
  write_file: "Writing",
  edit_file: "Editing",
  delete_file: "Deleting",
  rename_file: "Renaming",
  explore_folder: "Exploring",
  get_file_outline: "Outlining",
};

/** Pull a human-readable subject (file path, query, command) out of tool args. */
function subjectFromArgs(toolName: string, args: Record<string, unknown>): string | null {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  const path =
    str(args.path) ?? str(args.file_path) ?? str(args.filePath) ?? str(args.folder_path);
  if (path) {
    // Keep status line short: trailing 2 segments are enough to orient.
    const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length > 2 ? parts.slice(-2).join("/") : parts.join("/");
  }
  if (toolName === "web_search" || toolName === "search" || toolName === "search_code") {
    const q = str(args.query) ?? str(args.q);
    if (q) return q.length > 40 ? `${q.slice(0, 40)}…` : q;
  }
  if (toolName === "run_command" || toolName === "execute_command") {
    const cmd = str(args.command);
    if (cmd) {
      const first = cmd.split(/\s+/).slice(0, 3).join(" ");
      return first.length > 40 ? `${first.slice(0, 40)}…` : first;
    }
  }
  return null;
}

/**
 * Like getToolActivityLabel but folds in the tool's arguments when they
 * identify a concrete subject — e.g. "Writing src/auth.ts…".
 */
export function getToolActivityLabelWithArgs(
  toolName: string,
  args?: Record<string, unknown> | null,
): string {
  if (toolName && args) {
    const subject = subjectFromArgs(toolName, args);
    if (subject) {
      const verb = ARG_VERBS[toolName];
      if (verb) return `${verb} ${subject}…`;
      if (toolName === "web_search") return `Searching: ${subject}…`;
      if (toolName === "search" || toolName === "search_code")
        return `Searching for ${subject}…`;
      if (toolName === "run_command" || toolName === "execute_command")
        return `Running ${subject}…`;
    }
  }
  return getToolActivityLabel(toolName);
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
  visualize_graph: "Built graph",
  edit_file: "Edited file",
  run_command: "Ran command",
  execute_command: "Ran command",
  stream_terminal_output: "Streamed terminal output",
  web_search: "Searched the web",
  web_search_preview: "Searched the web",
  google_search: "Searched the web",
  deep_research: "Completed deep research",
  read_url: "Read URL",
  diagnose_issue: "Diagnosed issue",
  record_debug_hypothesis: "Recorded hypothesis",
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
