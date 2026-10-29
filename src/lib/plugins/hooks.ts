/**
 * Running hooks: the person's own (`<atlarixHomeDir>/hooks.json`) and those of
 * installed plugins. Never a workspace's — see `paths.ts`.
 *
 * Every run re-checks what it runs. For a plugin hook: the plugin is verified
 * (files and runnables, `registry.ts`) and the command must be one of the
 * `approvedHooks` the person saw at the second confirm. A plugin is only verified
 * when it has a hook for this event and tool, so plugins without hooks cost a
 * tool call nothing.
 *
 * Contract, per dialect (`hooks-config.ts`):
 * - stdin: one JSON object. Claude Code hooks get Claude Code's shape
 *   (`hook_event_name: "PreToolUse"`, `tool_name: "Bash"`, `tool_input`, …);
 *   Atlarix hooks get `event`, `tool`, `args`, `workspace`.
 * - `pre_tool_use` denies on a non-zero exit (Atlarix) or exit 2 / a JSON
 *   `decision: "block"` / `permissionDecision: "deny"` (Claude Code). What it
 *   printed goes to the model. A hook can only ever DENY: Claude Code's
 *   `permissionDecision: "allow"` is ignored, because approval belongs to the
 *   person's cards, not to a script.
 * - `stop`: same deny rule; the output is fed back and the turn goes on, bounded
 *   by the turn loop's gate counter.
 * - `prompt_submit` and `session_start`: what they print on success is added to
 *   the model's context, as in Claude Code; `prompt_submit` can block the prompt.
 * - `post_tool_use`: fire and forget.
 * - A timeout or a spawn failure never blocks; it is logged.
 *
 * Hooks run as the person's own commands — unsandboxed, like Claude Code's —
 * because the person approved exactly these command strings.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import log from "electron-log";
import {
  claudeNamesFor,
  hookMatchesTool,
  type HookEvent,
  type PluginHook,
} from "./hooks-config";
import { readPluginContents } from "./manifest";
import { pluginDir } from "./paths";
import {
  appliesToFolder,
  loadUserHooks,
  verifyInstalledPlugin,
} from "./registry";
import { readPluginRecords } from "./store";
import { sha256 } from "./tree-hash";

const logger = log.scope("hooks");

const OUTPUT_CAP = 64 * 1024;
const TAIL_CHARS = 2000;

const CLAUDE_EVENT_NAMES: Readonly<Record<HookEvent, string>> = {
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
  stop: "Stop",
  prompt_submit: "UserPromptSubmit",
  session_start: "SessionStart",
};

export interface HookContext {
  workspacePath?: string | null;
  sessionId?: string;
}

interface RunnableHook {
  hook: PluginHook;
  /** Plugin name, or null for the person's own hooks.json. */
  plugin: string | null;
  pluginRoot: string | null;
}

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Hooks for this event (and tool), each from a plugin that verifies right now. */
export function collectHooks(
  event: HookEvent,
  ctx: HookContext,
  tool?: { name: string; args: Record<string, unknown> },
): RunnableHook[] {
  const applies = (h: PluginHook) =>
    h.event === event && (!tool || hookMatchesTool(h, tool.name, tool.args));

  const out: RunnableHook[] = loadUserHooks()
    .hooks.filter(applies)
    .map((hook) => ({ hook, plugin: null, pluginRoot: null }));

  for (const record of readPluginRecords()) {
    if (!record.enabled || !appliesToFolder(record, ctx.workspacePath))
      continue;
    let candidates: PluginHook[];
    try {
      candidates = readPluginContents(
        pluginDir(record.name),
        record.name,
      ).hooks.filter(applies);
    } catch {
      continue; // unreadable: the load path reports it
    }
    if (candidates.length === 0) continue;
    const verified = verifyInstalledPlugin(record);
    if ("problem" in verified) {
      logger.warn(`hooks of ${record.name} skipped: ${verified.problem}`);
      continue;
    }
    for (const hook of verified.contents.hooks.filter(applies)) {
      if (!record.approvedHooks.includes(sha256(hook.command))) {
        logger.warn(
          `hook of ${record.name} skipped: command not approved: ${hook.command}`,
        );
        continue;
      }
      out.push({ hook, plugin: record.name, pluginRoot: verified.dir });
    }
  }
  return out;
}

function stdinFor(
  r: RunnableHook,
  ctx: HookContext,
  extra: {
    tool?: { name: string; args: Record<string, unknown> };
    result?: unknown;
    prompt?: string;
  },
): string {
  const args = extra.tool ? visibleArgs(extra.tool.args) : undefined;
  if (r.hook.dialect === "claude") {
    return JSON.stringify({
      session_id: ctx.sessionId ?? "",
      cwd: ctx.workspacePath ?? process.cwd(),
      hook_event_name: CLAUDE_EVENT_NAMES[r.hook.event],
      ...(extra.tool
        ? {
            tool_name:
              claudeNamesFor(extra.tool.name, extra.tool.args)[0] ??
              extra.tool.name,
            tool_input: claudeToolInput(extra.tool.args, ctx.workspacePath),
          }
        : {}),
      ...(extra.result !== undefined ? { tool_response: extra.result } : {}),
      ...(extra.prompt !== undefined ? { prompt: extra.prompt } : {}),
      ...(r.hook.event === "session_start" ? { source: "startup" } : {}),
      ...(r.hook.event === "stop" ? { stop_hook_active: false } : {}),
    });
  }
  return JSON.stringify({
    event: r.hook.event,
    workspace: ctx.workspacePath ?? null,
    session_id: ctx.sessionId ?? "",
    ...(extra.tool ? { tool: extra.tool.name, args } : {}),
    ...(extra.result !== undefined ? { result: extra.result } : {}),
    ...(extra.prompt !== undefined ? { prompt: extra.prompt } : {}),
  });
}

/** The model's arguments, without the harness's own `_…` and `workspace` keys. */
function visibleArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(
      ([k]) => !k.startsWith("_") && k !== "workspace",
    ),
  );
}

/**
 * Claude Code hooks read `tool_input.file_path` (absolute) for file tools; ours
 * call it `path`, often workspace-relative.
 */
function claudeToolInput(
  args: Record<string, unknown>,
  workspacePath: string | null | undefined,
): Record<string, unknown> {
  const input = visibleArgs(args);
  if (typeof input.path === "string" && input.file_path === undefined) {
    input.file_path = path.isAbsolute(input.path)
      ? input.path
      : path.resolve(workspacePath || process.cwd(), input.path);
  }
  return input;
}

function runOne(
  r: RunnableHook,
  ctx: HookContext,
  stdin: string,
  toolName?: string,
): Promise<HookRun> {
  const root = r.pluginRoot ?? "";
  // Placeholders are replaced in the text too, so a hook written for bash still
  // finds its script under cmd.exe, which does not expand ${…}.
  const command = r.pluginRoot
    ? r.hook.command.replace(/\$\{(CLAUDE|ATLARIX)_PLUGIN_ROOT\}/g, root)
    : r.hook.command;
  const cwd = ctx.workspacePath || r.pluginRoot || process.cwd();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        shell: true,
        cwd,
        env: {
          ...process.env,
          ATLARIX_HOOK_EVENT: r.hook.event,
          ATLARIX_PROJECT_DIR: ctx.workspacePath ?? "",
          CLAUDE_PROJECT_DIR: ctx.workspacePath ?? "",
          ...(toolName ? { ATLARIX_TOOL: toolName } : {}),
          ...(r.pluginRoot
            ? { ATLARIX_PLUGIN_ROOT: root, CLAUDE_PLUGIN_ROOT: root }
            : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      logger.warn(`hook failed to start (${r.hook.command}): ${String(err)}`);
      resolve({ code: null, stdout: "", stderr: String(err), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, r.hook.timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut)
        logger.warn(
          `hook timed out after ${r.hook.timeoutMs}ms: ${r.hook.command}`,
        );
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin?.on("error", () => {}); // a hook that never reads stdin
    child.stdin?.end(stdin);
  });
}

/** The reason a hook denied, or null when it let things through. */
function denial(r: RunnableHook, run: HookRun): string | null {
  if (run.timedOut || run.code === null) return null;
  const json = parseJsonObject(run.stdout);
  if (r.hook.dialect === "claude") {
    const specific = json?.hookSpecificOutput as
      | Record<string, unknown>
      | undefined;
    if (specific?.permissionDecision === "deny") {
      return String(
        specific.permissionDecisionReason ?? json?.reason ?? tail(run),
      );
    }
    if (json?.decision === "block") return String(json.reason ?? tail(run));
    return run.code === 2 ? tail(run, "stderr") : null;
  }
  return run.code !== 0 ? tail(run) : null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function tail(run: HookRun, prefer: "stderr" | "both" = "both"): string {
  const text =
    prefer === "stderr"
      ? run.stderr || run.stdout
      : `${run.stderr}\n${run.stdout}`;
  const t = text.trim();
  return (
    (t.length > TAIL_CHARS ? `…${t.slice(-TAIL_CHARS)}` : t) || "(no output)"
  );
}

function label(r: RunnableHook): string {
  return r.plugin
    ? `${r.plugin}: ${r.hook.command}`
    : `hooks.json: ${r.hook.command}`;
}

export interface HookDenial {
  deniedBy: string;
  reason: string;
}

/** Runs in order; the first denial wins and later hooks do not run. */
export async function runPreToolUseHooks(
  ctx: HookContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<HookDenial | null> {
  const tool = { name: toolName, args };
  for (const r of collectHooks("pre_tool_use", ctx, tool)) {
    const run = await runOne(r, ctx, stdinFor(r, ctx, { tool }), toolName);
    const reason = denial(r, run);
    if (reason != null) return { deniedBy: label(r), reason };
  }
  return null;
}

export function runPostToolUseHooks(
  ctx: HookContext,
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
): void {
  const tool = { name: toolName, args };
  const hooks = collectHooks("post_tool_use", ctx, tool);
  for (const r of hooks) {
    void runOne(r, ctx, stdinFor(r, ctx, { tool, result }), toolName);
  }
}

/** Feedback for the model when a stop hook says the work is not done; null = done. */
export async function runStopHooks(ctx: HookContext): Promise<string | null> {
  for (const r of collectHooks("stop", ctx)) {
    const run = await runOne(r, ctx, stdinFor(r, ctx, {}));
    const reason = denial(r, run);
    if (reason != null) {
      return `A stop hook says this is not done yet (${label(r)}):\n${reason}\nFix it, then finish.`;
    }
  }
  return null;
}

export interface PromptHookResult {
  /** Set when a hook blocked the prompt: shown to the person, the turn does not run. */
  blocked: string | null;
  /** What the hooks printed, for the model's context. */
  context: string[];
}

export async function runPromptSubmitHooks(
  ctx: HookContext,
  prompt: string,
): Promise<PromptHookResult> {
  const context: string[] = [];
  for (const r of collectHooks("prompt_submit", ctx)) {
    const run = await runOne(r, ctx, stdinFor(r, ctx, { prompt }));
    const reason = denial(r, run);
    if (reason != null) return { blocked: `${label(r)}: ${reason}`, context };
    const added = contextFrom(run);
    if (added) context.push(added);
  }
  return { blocked: null, context };
}

export async function runSessionStartHooks(
  ctx: HookContext,
): Promise<string[]> {
  const context: string[] = [];
  for (const r of collectHooks("session_start", ctx)) {
    const added = contextFrom(await runOne(r, ctx, stdinFor(r, ctx, {})));
    if (added) context.push(added);
  }
  return context;
}

/** Plain stdout, or Claude Code's `hookSpecificOutput.additionalContext`. */
function contextFrom(run: HookRun): string | null {
  if (run.timedOut || run.code !== 0) return null;
  const json = parseJsonObject(run.stdout);
  const specific = json?.hookSpecificOutput as
    | Record<string, unknown>
    | undefined;
  const text =
    typeof specific?.additionalContext === "string"
      ? specific.additionalContext
      : json
        ? ""
        : run.stdout;
  const t = text.trim();
  return t ? (t.length > OUTPUT_CAP ? t.slice(0, OUTPUT_CAP) : t) : null;
}

export function hasHooksFor(event: HookEvent, ctx: HookContext): boolean {
  return collectHooks(event, ctx).length > 0;
}
