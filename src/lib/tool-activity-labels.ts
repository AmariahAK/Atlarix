/**
 * Human-readable labels for AI tool activity (chat status line).
 * Fix: Finding 4
 */

const LABELS: Record<string, string> = {
  // v13 surface (legacy names below are kept for persisted sessions)
  glob: "Finding files…",
  grep: "Searching code…",
  plan: "Updating plan…",
  task: "Running sub-agent…",
  read_file: "Reading files…",
  write_file: "Writing code…",
  write_multiple_files: "Writing files…",
  delete_file: "Deleting file…",
  rename_file: "Renaming file…",
  list_files: "Listing files…",
  explore_folder: "Exploring folder…",
  search_code: "Searching code…",
  search: "Searching codebase…",
  find_file: "Finding files…",
  edit_file: "Editing file…",
  run_command: "Running command…",
  execute_command: "Running command…",
  stream_terminal_output: "Streaming terminal…",
  web_search: "Searching the web…",
  web_search_preview: "Searching the web…",
  google_search: "Searching the web…",
  deep_research: "Deep research…",
  read_url: "Reading URL…",
  browser_navigate: "Opening page…",
  browser_inspect: "Inspecting page…",
  browser_interact: "Acting on page…",
  background_jobs: "Checking background jobs…",
  diagnose_issue: "Diagnosing issue…",
  record_debug_hypothesis: "Recording debug hypothesis…",
  memory: "Recalling memory…",
  list_available_mcps: "Listing MCP servers…",
  mcp_call: "Calling MCP tool…",
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
};

/** Clamp a subject string so status lines stay short. */
function clampSubject(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Pull a human-readable subject (file path, query, command) out of tool args. */
function subjectFromArgs(toolName: string, args: Record<string, unknown>): string | null {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  // grep/glob first: their `pattern` is the subject, and grep's `path` arg is the
  // search root (not what we want to surface), so this must precede the path check.
  if (toolName === "grep" || toolName === "glob") {
    const pattern = str(args.pattern) ?? str(args.query);
    if (pattern) {
      const include = toolName === "grep" ? str(args.include) : null;
      return clampSubject(include ? `${pattern} in ${include}` : pattern);
    }
  }
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

const BROWSER_TOOLS = new Set([
  "browser_navigate",
  "browser_inspect",
  "browser_interact",
]);

function shortText(s: string, max = 28): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function hostFromUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return u.host + (u.pathname && u.pathname !== "/" ? u.pathname : "");
  } catch {
    return raw;
  }
}

/**
 * Arg-aware label for the browser/preview tools, in either tense. Reads the
 * tool-call args {action, value, ref, selector, target, mode, url} so cards say
 * "Filling 'Your email' · preview" / "Clicked 'Sign up' · preview" /
 * "Inspected preview" instead of the generic (and previously broken "Runned …").
 */
export function browserToolLabel(
  toolName: string,
  args: Record<string, unknown> | null | undefined,
  tense: "running" | "done",
): string | null {
  if (!BROWSER_TOOLS.has(toolName)) return null;
  const a = args ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const isPreview = a.target === "preview";
  const suffix = isPreview ? " · preview" : "";
  const noun = isPreview ? "preview" : "page";

  if (toolName === "browser_navigate") {
    const where = str(a.url)
      ? ` ${shortText(hostFromUrl(str(a.url)))}`
      : isPreview
        ? " preview"
        : "";
    return tense === "running"
      ? `Opening${where || " page"}…`
      : `Opened${where || " page"}`;
  }

  if (toolName === "browser_inspect") {
    const mode = str(a.mode) || "snapshot";
    const map: Record<string, [string, string]> = {
      snapshot: [`Inspecting ${noun}`, `Inspected ${noun}`],
      text: [`Reading ${noun} text`, `Read ${noun} text`],
      screenshot: [`Capturing ${noun} screenshot`, `Captured ${noun} screenshot`],
      console: [`Reading ${noun} console`, `Read ${noun} console`],
    };
    const [run, done] = map[mode] ?? map.snapshot;
    return tense === "running" ? `${run}…` : done;
  }

  if (toolName === "browser_interact") {
    const action = str(a.action);
    if (action === "fill") {
      const what = str(a.value) ? ` "${shortText(str(a.value), 24)}"` : " field";
      return (tense === "running" ? `Filling${what}` : `Filled${what}`) + suffix;
    }
    if (action === "click") {
      const label = str(a.ref) || str(a.selector);
      const what = label ? ` ${shortText(label, 24)}` : " element";
      return (tense === "running" ? `Clicking${what}` : `Clicked${what}`) + suffix;
    }
    return (tense === "running" ? "Acting on page" : "Acted on page") + suffix;
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
    const browser = browserToolLabel(toolName, args, "running");
    if (browser) return `${browser.replace(/…$/u, "")}…`;
    // v13.8: edit_file absorbed write_file — a whole-file write reads as
    // "Writing …", surgical ops as "Editing …".
    const isWholeFileWrite = toolName === "edit_file" && args.operation === "write";
    const subject = subjectFromArgs(toolName, args);
    if (subject) {
      const verb = isWholeFileWrite ? "Writing" : ARG_VERBS[toolName];
      if (verb) return `${verb} ${subject}…`;
      if (toolName === "web_search") return `Searching: ${subject}…`;
      if (toolName === "grep") return `Searching for ${subject}…`;
      if (toolName === "glob") return `Finding files ${subject}…`;
      if (toolName === "search" || toolName === "search_code")
        return `Searching for ${subject}…`;
      if (toolName === "run_command" || toolName === "execute_command")
        return `Running ${subject}…`;
    }
  }
  return getToolActivityLabel(toolName);
}

const DONE_LABELS: Record<string, string> = {
  // v13 surface (legacy names below are kept for persisted sessions)
  glob: "Found files",
  grep: "Searched code",
  plan: "Plan updated",
  task: "Sub-agent finished",
  read_file: "Read files",
  write_file: "Wrote file",
  write_multiple_files: "Wrote files",
  delete_file: "Deleted file",
  rename_file: "Renamed file",
  list_files: "Listed files",
  explore_folder: "Explored folder",
  search_code: "Searched codebase",
  search: "Ran codebase search",
  find_file: "Found files",
  edit_file: "Edited file",
  run_command: "Ran command",
  execute_command: "Ran command",
  stream_terminal_output: "Streamed terminal output",
  web_search: "Searched the web",
  web_search_preview: "Searched the web",
  google_search: "Searched the web",
  deep_research: "Completed deep research",
  read_url: "Read URL",
  browser_navigate: "Opened page",
  browser_inspect: "Inspected page",
  browser_interact: "Acted on page",
  background_jobs: "Checked background jobs",
  diagnose_issue: "Diagnosed issue",
  record_debug_hypothesis: "Recorded hypothesis",
  memory: "Recalled memory",
  list_available_mcps: "Listed MCP servers",
  mcp_call: "Called MCP tool",
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
};

/** Past-tense label for completed tool cards (arg-aware for browser tools). */
export function getToolDoneLabel(
  toolName: string,
  args?: Record<string, unknown> | null,
): string {
  if (!toolName) return "Done";
  if (args) {
    const browser = browserToolLabel(toolName, args, "done");
    if (browser) return browser;
    if (toolName === "grep" || toolName === "glob") {
      const subject = subjectFromArgs(toolName, args);
      if (subject) {
        return toolName === "grep"
          ? `Searched for ${subject}`
          : `Found files matching ${subject}`;
      }
    }
  }
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
