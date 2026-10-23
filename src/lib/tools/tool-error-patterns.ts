/**
 * Actionable tool errors (v10)
 * ============================
 * Every failure the model sees should answer three questions:
 *   1. What happened?  2. Why?  3. What should I do next?
 * `read_file`'s structured errors (file-read-errors.ts) are the template.
 * This module supplies per-tool recovery hints that ToolRegistry.execute
 * merges into failures whose message lacks actionable guidance.
 */

/**
 * Default next-step hint per tool, used when a failure message is bare.
 * Keyed by the REAL tool surface (v13.8: write_file→edit_file operation:"write",
 * list_files/explore_folder/find_file/search→glob/grep, the plan_* tools→plan).
 */
export const TOOL_RECOVERY_HINTS: Record<string, string> = {
  read_file:
    "Use glob to locate the correct path by name, or grep to find the file by its content (relevance-ranked, symbol-annotated hits).",
  edit_file:
    'Re-read the file with read_file first — the target content may have changed. To create a file or fully rewrite it, use operation:"write" with the full content. In Plan mode only .atlarix/atlarix.md and .atlarix/memory.md are writable.',
  glob: "No matches is often an extension or casing issue — try a broader pattern, or use grep to find the file by its content.",
  grep: "Try a simpler query. To list files by name instead of content, use glob; read exact ranges with read_file.",
  run_command:
    "If it timed out, pass a larger timeout_ms or split the command. If it needs interaction, add non-interactive flags (e.g. --yes, CI=true).",
  task: "Check the sub-agent task description and retry; at most 5 task calls per turn. Sub-agents read and search by default (glob/grep/read_file/web_search/read_url); write:true adds edit_file, whose changes come back as per-file proposals for you to review — never run_command. Manage running ones with the subagents tool.",
  plan: 'Use the planId from the active session plan in context, or plan({operation:"read"}) to find it. Valid operations: write, read, set_status, update_step, append_step.',
  mcp_call:
    "Call list_available_mcps first to see connected servers and exact tool names. If authentication failed, the user must Connect/Configure the server in Settings → Tools & MCP.",
  list_available_mcps:
    "MCP servers are configured per workspace in Settings → Tools & MCP.",
  web_search:
    "Retry with a shorter, keyword-style query. If search stays unavailable, tell the user they can connect a search/web MCP in Settings → Tools & MCP.",
  read_url:
    "Check the URL is complete (https://…). JS-heavy pages are handled — read_url renders them in a real browser when a plain fetch comes back empty. A paywall or a login wall is not something to work around: say the page is not publicly readable.",
  read_attachment:
    "Call list_attachments to see valid attachment ids for this chat.",
  // `target:"preview"` was REMOVED with the Preview pane in v14.15.0 — the app you
  // are building now runs in an ordinary browser tab. These strings are recovery
  // advice shown AFTER a call already failed, so naming a parameter that no longer
  // exists sent a stuck model straight into a second invalid call.
  browser:
    'Every page action is one tool: browser({action:…}). Only http(s) URLs for action:"navigate" — to drive the app you are building, navigate to its dev-server URL (e.g. http://localhost:3000) like any other page. Act by `ref` (there is no `selector`): get a fresh one from browser_inspect(mode:"snapshot") or action:"find". With more than one tab open, pass the same tab_id you inspected.',
  browser_inspect:
    'Open a page first with browser({action:"navigate", url}). mode:"snapshot" lists interactive refs; mode:"console" shows runtime errors with stacks. If no browser is connected, the user needs Chrome/Edge/Brave open with the Atlarix extension — say so rather than retrying.',
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
