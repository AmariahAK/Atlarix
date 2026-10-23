/**
 * Human-readable labels for AI tool activity (chat status line).
 * Fix: Finding 4
 */
import { displayTitle } from "@/shared/mcp-catalog";

const LABELS: Record<string, string> = {
  // Four tools shipped without entries here and fell through to the generic
  // `Running <tool name>…` template — the documented "Runned <tool>" trap, caught by
  // `tool-activity-labels-coverage.test.ts` rather than by the next person to notice.
  compress_context: "Compacting context…",
  session_search: "Searching session history…",
  list_attachments: "Listing attachments…",
  schedule_wakeup: "Setting a timer…",
  relic: "Making a relic…",
  read_attachment: "Reading attachment…",
  view_image: "Looking at image…",
  transcribe_audio: "Transcribing audio…",
  list_sessions: "Listing sessions…",
  send_message: "Messaging a session…",
  // v13 surface (legacy names below are kept for persisted sessions)
  glob: "Finding files…",
  grep: "Searching code…",
  plan: "Updating plan…",
  automations: "Checking automations…",
  task: "Running sub-agent…",
  subagents: "Checking sub-agents…",
  tool_help: "Reading tool usage…",
  proposals: "Reviewing proposed changes…",
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
  browser_inspect: "Reading page…",
  // One entry for the consolidated act tool; `browserToolLabel` refines it per
  // action ("Clicking…", "Opening page…") from the args.
  browser: "Acting on page…",
  // Retired names, KEPT. A reloaded session or a stored activity row still
  // carries them, and this plain lookup is the path taken when no args are
  // available — without these, old history would read "Running browser
  // navigate…" / "Completed browser navigate".
  browser_navigate: "Opening page…",
  browser_interact: "Acting on page…",
  browser_find: "Finding on page…",
  browser_tabs: "Managing tabs…",
  browser_batch: "Running browser steps…",
  browser_test: "Testing the app…",
  background_jobs: "Checking background jobs…",
  diagnose_issue: "Diagnosing issue…",
  record_debug_hypothesis: "Recording debug hypothesis…",
  memory: "Recalling memory…",
  list_available_mcps: "Listing MCP servers…",
  manage_mcp_server: "Preparing MCP server change…",
  mcp_call: "Calling MCP tool…",
  mcp_servers: "Checking MCP servers…",
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
  // Without an entry here a subject is computed and then silently DISCARDED,
  // which is why adding one to subjectFromArgs changed nothing on its own.
  tool_help: "Reading",
};

/** Clamp a subject string so status lines stay short. */
function clampSubject(s: string, max = 40): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Pull a human-readable subject (file path, query, command) out of tool args. */
function subjectFromArgs(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  // grep/glob first: their `pattern` is the subject, and grep's `path` arg is the
  // search root (not what we want to surface), so this must precede the path check.
  // `tool_help` reads ONE tool's instructions, so the row should say which —
  // "Read tool usage" was the same string whatever it fetched.
  if (toolName === "tool_help") {
    const tool = str(args.tool);
    if (tool) return tool;
  }
  if (toolName === "grep" || toolName === "glob") {
    const pattern = str(args.pattern) ?? str(args.query);
    if (pattern) {
      const include = toolName === "grep" ? str(args.include) : null;
      return clampSubject(include ? `${pattern} in ${include}` : pattern);
    }
  }
  const path =
    str(args.path) ??
    str(args.file_path) ??
    str(args.filePath) ??
    str(args.folder_path);
  if (path) {
    // Keep status line short: trailing 2 segments are enough to orient.
    const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length > 2 ? parts.slice(-2).join("/") : parts.join("/");
  }
  if (
    toolName === "web_search" ||
    toolName === "search" ||
    toolName === "search_code"
  ) {
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
 * The two browser tools. Six collapsed into these, so the arg-aware labels
 * below now key off `args.action` for `browser` rather than off five tool names.
 *
 * The retired names stay in the set deliberately: a REPLAYED transcript (a
 * reloaded session, a stored activity row) still carries them, and a card that
 * rendered "Completed browser navigate" for history would be a visible
 * regression in old sessions.
 */
const BROWSER_TOOLS = new Set([
  "browser",
  "browser_inspect",
  // Retired names — still labelled so historical activity rows read correctly.
  "browser_navigate",
  "browser_interact",
  "browser_find",
  "browser_tabs",
  "browser_batch",
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
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : "";
  const isPreview = a.target === "preview";
  const suffix = isPreview ? " · preview" : "";
  const noun = isPreview ? "preview" : "page";

  // `browser` carries the verb in `action`; the retired tool names carry it in
  // the name itself. Normalise to one verb so each label lives in one place.
  const verb =
    toolName === "browser"
      ? str(a.action)
      : toolName.startsWith("browser_")
        ? toolName.slice("browser_".length)
        : "";

  if (verb === "navigate") {
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
    const mode = str(a.mode) || "read";
    const map: Record<string, [string, string]> = {
      read: [`Reading ${noun}`, `Read ${noun}`],
      snapshot: [`Inspecting ${noun}`, `Inspected ${noun}`],
      text: [`Reading ${noun} text`, `Read ${noun} text`],
      visual: [`Checking ${noun} layout`, `Checked ${noun} layout`],
      design: [`Reading ${noun} design`, `Read ${noun} design`],
      screenshot: [
        `Capturing ${noun} screenshot`,
        `Captured ${noun} screenshot`,
      ],
      console: [`Reading ${noun} console`, `Read ${noun} console`],
      network: [
        `Reading ${noun} network errors`,
        `Read ${noun} network errors`,
      ],
    };
    const [run, done] = map[mode] ?? map.read;
    return tense === "running" ? `${run}…` : done;
  }

  if (verb === "find") {
    const q = str(a.query) ? ` "${shortText(str(a.query), 28)}"` : "";
    return tense === "running" ? `Finding${q}…` : `Found${q}`;
  }

  if (verb === "tabs") {
    const op = str(a.operation);
    const map: Record<string, [string, string]> = {
      list: ["Listing browser tabs", "Listed browser tabs"],
      create: ["Opening a new tab", "Opened a new tab"],
      switch: ["Switching tab", "Switched tab"],
      close: ["Closing tab", "Closed tab"],
    };
    const [run, done] = map[op] ?? ["Managing tabs", "Managed tabs"];
    return tense === "running" ? `${run}…` : done;
  }

  if (verb === "batch") {
    const n = Array.isArray(a.steps) ? a.steps.length : 0;
    const what = n ? ` ${n} step${n === 1 ? "" : "s"}` : "";
    return tense === "running"
      ? `Running${what} in the browser…`
      : `Ran${what} in the browser`;
  }

  // The five act verbs, whether they arrived as `browser({action})` or as the
  // retired `browser_interact({action})`.
  //
  // This block always returns, and that is correct rather than an oversight:
  // the ONLY null path is the `BROWSER_TOOLS` guard at the top of the function,
  // which is what lets a non-browser tool fall through to `subjectFromArgs` in
  // the callers. A trailing `return null` here would be unreachable, so a
  // browser tool with an unrecognised action gets the generic act label instead.
  {
    const action = verb === "interact" ? str(a.action) : verb;
    if (action === "fill") {
      const what = str(a.value)
        ? ` "${shortText(str(a.value), 24)}"`
        : " field";
      return (
        (tense === "running" ? `Filling${what}` : `Filled${what}`) + suffix
      );
    }
    if (action === "click") {
      const label = str(a.ref) || str(a.selector);
      const what = label ? ` ${shortText(label, 24)}` : " element";
      return (
        (tense === "running" ? `Clicking${what}` : `Clicked${what}`) + suffix
      );
    }
    if (action === "key") {
      const key = str(a.text) ? ` ${shortText(str(a.text), 16)}` : " a key";
      return (
        (tense === "running" ? `Pressing${key}` : `Pressed${key}`) + suffix
      );
    }
    if (action === "hover") {
      const label = str(a.ref) || str(a.selector);
      const what = label ? ` ${shortText(label, 24)}` : " element";
      return (
        (tense === "running" ? `Hovering${what}` : `Hovered${what}`) + suffix
      );
    }
    if (action === "scroll") {
      const dir =
        str(a.ref) || str(a.selector)
          ? " into view"
          : ` ${str(a.direction) || "down"}`;
      return (
        (tense === "running" ? `Scrolling${dir}` : `Scrolled${dir}`) + suffix
      );
    }
    return (tense === "running" ? "Acting on page" : "Acted on page") + suffix;
  }
}

/**
 * Like getToolActivityLabel but folds in the tool's arguments when they
 * identify a concrete subject — e.g. "Writing src/auth.ts…".
 */
/** An MCP tool's name as words: `list_issues` → `list issues`. */
const mcpToolWords = (v: unknown) =>
  typeof v === "string" ? v.replace(/[_-]+/g, " ").trim() : "";

/**
 * MCP rows name what is used: "Using Linear: list issues…", then
 * "Linear · list issues" with its data, like any other tool row.
 */
function mcpLabel(
  toolName: string,
  args: Record<string, unknown>,
  phase: "running" | "done",
): string | null {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (toolName === "mcp_call") {
    const server = str(args.server);
    const tool = mcpToolWords(args.tool);
    if (!server) return null;
    return phase === "running"
      ? `Using ${server}${tool ? `: ${tool}` : ""}…`
      : `${server}${tool ? ` · ${tool}` : ""}`;
  }
  if (toolName === "mcp_servers") {
    const op = str(args.operation);
    // "Suggesting Canva", not the registry id "com.canva.mcp/mcp" (QA).
    const rawServer = str(args.server);
    const server = rawServer.includes("/") ? displayTitle({ name: rawServer }) : rawServer;
    const query = str(args.query);
    if (op === "search") {
      return phase === "running"
        ? `Searching MCP servers${query ? ` for "${query}"` : ""}…`
        : `Searched MCP servers${query ? ` for "${query}"` : ""}`;
    }
    if (op === "defaults") {
      const set = Array.isArray(args.servers);
      if (phase === "running") return set ? "Setting default MCP servers…" : "Reading default MCP servers…";
      return set ? "Set default MCP servers" : "Read default MCP servers";
    }
    if (!server) return null;
    const verbs: Record<string, [string, string]> = {
      suggest: ["Suggesting", "Suggested"],
      start: ["Turning on", "Turned on"],
      stop: ["Turning off", "Turned off"],
      disconnect: ["Signing out of", "Signed out of"],
    };
    const v = verbs[op];
    if (!v) return null;
    return phase === "running" ? `${v[0]} ${server}…` : `${v[1]} ${server}`;
  }
  return null;
}

export function getToolActivityLabelWithArgs(
  toolName: string,
  args?: Record<string, unknown> | null,
): string {
  if (toolName && args) {
    const mcp = mcpLabel(toolName, args, "running");
    if (mcp) return mcp;
    const browser = browserToolLabel(toolName, args, "running");
    if (browser) return `${browser.replace(/…$/u, "")}…`;
    // v13.8: edit_file absorbed write_file — a whole-file write reads as
    // "Writing …", surgical ops as "Editing …".
    const isWholeFileWrite =
      toolName === "edit_file" && args.operation === "write";
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
  compress_context: "Context compacted",
  session_search: "Searched session history",
  list_attachments: "Listed attachments",
  read_attachment: "Read attachment",
  view_image: "Viewed image",
  transcribe_audio: "Transcribed audio",
  list_sessions: "Listed sessions",
  send_message: "Sent a message",
  schedule_wakeup: "Timer set",
  relic: "Relic ready",
  // v13 surface (legacy names below are kept for persisted sessions)
  glob: "Found files",
  grep: "Searched code",
  plan: "Plan updated",
  automations: "Automations updated",
  task: "Sub-agent finished",
  subagents: "Checked sub-agents",
  tool_help: "Read tool usage",
  proposals: "Reviewed proposed changes",
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
  browser_inspect: "Read page",
  browser: "Acted on page",
  // Retired names — see the note in LABELS above.
  browser_navigate: "Opened page",
  browser_interact: "Acted on page",
  browser_find: "Found on page",
  browser_tabs: "Managed tabs",
  browser_batch: "Ran browser steps",
  browser_test: "Tested the app",
  background_jobs: "Checked background jobs",
  diagnose_issue: "Diagnosed issue",
  record_debug_hypothesis: "Recorded hypothesis",
  memory: "Recalled memory",
  list_available_mcps: "Listed MCP servers",
  manage_mcp_server: "Proposed MCP server change",
  mcp_call: "Called MCP tool",
  mcp_servers: "Checked MCP servers",
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
    const mcp = mcpLabel(toolName, args, "done");
    if (mcp) return mcp;
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
    // Name the tool whose instructions were fetched. "Read tool usage" was the
    // same string for every call, which made the row useless for telling apart
    // several reveals in one turn.
    if (toolName === "tool_help") {
      const subject = subjectFromArgs(toolName, args);
      if (subject) return `Read ${subject} usage`;
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
  // Conjugating only makes sense for a HAND-WRITTEN label ("Searching code" →
  // "Searched code"). The generic template is `Running <tool>`, whose first
  // /ing\b/ sits inside "Runn·ing" — so conjugating it produced "Runned
  // subagents" for any tool missing from the maps above. Give the generic case
  // a generic past tense instead of mangling the verb.
  const spaced = toolName.replace(/_/g, " ");
  if (running === `Running ${spaced}`) return `Completed ${spaced}`;
  if (/ing\b/i.test(running)) {
    return running.replace(/ing\b/i, "ed");
  }
  return running || "Done";
}
