/**
 * Hook files, in both shapes Atlarix reads, normalised to one `PluginHook`.
 *
 * Atlarix's own (`hooks/hooks.json` in an Atlarix plugin, or `<atlarixHomeDir>/hooks.json`):
 *
 *   { "hooks": [
 *       { "event": "pre_tool_use", "match": "edit_file(src/db/*)",
 *         "command": "./scripts/check-migrations.sh" },
 *       { "event": "stop", "command": "npm test --silent" }
 *   ] }
 *
 *   `match` is the permission-ruleset syntax (`tool(glob)` or a bare tool glob),
 *   the same one `deny` rules use; omitted = every tool. Ignored off the tool events.
 *
 * Claude Code's (`hooks/hooks.json` in a `.claude-plugin` plugin):
 *
 *   { "hooks": { "PreToolUse": [ { "matcher": "Bash|Edit",
 *       "hooks": [ { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/x.sh", "timeout": 30 } ] } ] } }
 *
 *   `matcher` is a regex over CLAUDE CODE's tool names, so it is kept as written and
 *   tested against the Claude names of each Atlarix tool (`CLAUDE_TOOL_NAMES`) at run
 *   time, rather than translated into a rule that would mean something slightly
 *   different. A Claude Code mod (`{ "modules": [...] }`) is not a hook file at all:
 *   its API is Claude Code's, and it is reported as unsupported.
 *
 * Events: `pre_tool_use` (a non-zero exit denies the tool, its stderr goes to the
 * model), `post_tool_use`, `stop` (the turn is not done until it passes),
 * `prompt_submit`, `session_start`. Anything else is listed as unsupported so the
 * install screen can say so instead of dropping it silently.
 */

import {
  compileRule,
  ruleMatches,
  ruleMatchTarget,
} from "@/lib/tools/permissions/ruleset";

export const HOOK_EVENTS = [
  "pre_tool_use",
  "post_tool_use",
  "stop",
  "prompt_submit",
  "session_start",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

const CLAUDE_EVENT_MAP: Readonly<Record<string, HookEvent>> = {
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  Stop: "stop",
  UserPromptSubmit: "prompt_submit",
  SessionStart: "session_start",
};

/**
 * Atlarix tool → the Claude Code tool name(s) a Claude matcher would use for it.
 * One table, used both ways: hook matchers here, plugin agents' `tools:` lists in
 * `claude-layout.ts`.
 */
export const CLAUDE_TOOL_NAMES: Readonly<Record<string, readonly string[]>> = {
  run_command: ["Bash"],
  read_file: ["Read"],
  edit_file: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
  grep: ["Grep"],
  glob: ["Glob"],
  read_url: ["WebFetch"],
  web_search: ["WebSearch"],
  task: ["Task", "Agent"],
  plan: ["TodoWrite"],
  ask_user: ["AskUserQuestion"],
};

export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

export type HookMatch =
  | { kind: "all" }
  | { kind: "rule"; rule: string }
  | { kind: "claude"; regex: string };

export interface PluginHook {
  event: HookEvent;
  match: HookMatch;
  command: string;
  timeoutMs: number;
}

export interface ParsedHooks {
  hooks: PluginHook[];
  /** Human-readable lines for what was present but will not run. */
  unsupported: string[];
  /** A Claude Code JS mod (`{ "modules": [...] }`), which Atlarix does not run. */
  claudeModModules: string[];
}

const EMPTY: ParsedHooks = { hooks: [], unsupported: [], claudeModModules: [] };

export function parseHooksJson(raw: string): ParsedHooks {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ...EMPTY, unsupported: ["hooks.json is not valid JSON"] };
  }
  if (!data || typeof data !== "object") return EMPTY;
  const obj = data as Record<string, unknown>;

  const claudeModModules = Array.isArray(obj.modules)
    ? obj.modules.filter((m): m is string => typeof m === "string")
    : [];

  if (Array.isArray(obj.hooks))
    return { ...parseAtlarixHooks(obj.hooks), claudeModModules };
  if (obj.hooks && typeof obj.hooks === "object") {
    return {
      ...parseClaudeHooks(obj.hooks as Record<string, unknown>),
      claudeModModules,
    };
  }
  return { ...EMPTY, claudeModModules };
}

function parseAtlarixHooks(
  list: unknown[],
): Omit<ParsedHooks, "claudeModModules"> {
  const hooks: PluginHook[] = [];
  const unsupported: string[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const h = item as Record<string, unknown>;
    const event = h.event;
    const command = typeof h.command === "string" ? h.command.trim() : "";
    if (!command) continue;
    if (
      typeof event !== "string" ||
      !(HOOK_EVENTS as readonly string[]).includes(event)
    ) {
      unsupported.push(`hook on "${String(event)}": not an Atlarix event`);
      continue;
    }
    let match: HookMatch = { kind: "all" };
    if (typeof h.match === "string" && h.match.trim()) {
      if (!compileRule(h.match)) {
        unsupported.push(`hook match "${h.match}": not a tool(glob) rule`);
        continue;
      }
      match = { kind: "rule", rule: h.match.trim() };
    }
    hooks.push({
      event: event as HookEvent,
      match,
      command,
      timeoutMs: timeoutOf(h.timeoutMs, 1),
    });
  }
  return { hooks, unsupported };
}

function parseClaudeHooks(
  byEvent: Record<string, unknown>,
): Omit<ParsedHooks, "claudeModModules"> {
  const hooks: PluginHook[] = [];
  const unsupported: string[] = [];
  for (const [claudeEvent, groups] of Object.entries(byEvent)) {
    const event = CLAUDE_EVENT_MAP[claudeEvent];
    if (!event) {
      unsupported.push(`${claudeEvent} hooks: no Atlarix event`);
      continue;
    }
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const g = group as Record<string, unknown>;
      const matcher = typeof g.matcher === "string" ? g.matcher.trim() : "";
      let match: HookMatch = { kind: "all" };
      if (matcher && matcher !== "*") {
        try {
          new RegExp(matcher);
          match = { kind: "claude", regex: matcher };
        } catch {
          unsupported.push(
            `${claudeEvent} matcher "${matcher}": not a valid pattern`,
          );
          continue;
        }
      }
      for (const entry of Array.isArray(g.hooks) ? g.hooks : []) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        if (e.type !== "command") {
          unsupported.push(`${claudeEvent} hook of type "${String(e.type)}"`);
          continue;
        }
        const command = typeof e.command === "string" ? e.command.trim() : "";
        if (!command) continue;
        // Claude Code's `timeout` is in seconds.
        hooks.push({
          event,
          match,
          command,
          timeoutMs: timeoutOf(e.timeout, 1000),
        });
      }
    }
  }
  return { hooks, unsupported };
}

function timeoutOf(value: unknown, unitMs: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value * unitMs)
    : DEFAULT_HOOK_TIMEOUT_MS;
}

/** Whether a hook applies to this tool call. Off the tool events, always. */
export function hookMatchesTool(
  hook: PluginHook,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  switch (hook.match.kind) {
    case "all":
      return true;
    case "rule": {
      const rule = compileRule(hook.match.rule);
      return (
        !!rule && ruleMatches(rule, toolName, ruleMatchTarget(toolName, args))
      );
    }
    case "claude": {
      const re = new RegExp(`^(?:${hook.match.regex})$`);
      const names = claudeNamesFor(toolName, args);
      return names.some((n) => re.test(n));
    }
  }
}

/**
 * The Claude Code names a matcher might use for this Atlarix call. An MCP call is
 * `mcp__<server>__<tool>` there; anything unmapped is tried under its own name.
 */
export function claudeNamesFor(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  if (toolName === "mcp_call") {
    const server = typeof args.server === "string" ? args.server : "";
    const tool = typeof args.tool === "string" ? args.tool : "";
    return server && tool ? [`mcp__${server}__${tool}`] : [];
  }
  return [...(CLAUDE_TOOL_NAMES[toolName] ?? []), toolName];
}

/** One line per hook for the install screen and `/plugins`: shown in full, never shortened. */
export function describeHook(h: PluginHook): string {
  const on =
    h.match.kind === "all"
      ? ""
      : h.match.kind === "rule"
        ? ` ${h.match.rule}`
        : ` ${h.match.regex}`;
  return `${h.event}${on}: ${h.command}`;
}
