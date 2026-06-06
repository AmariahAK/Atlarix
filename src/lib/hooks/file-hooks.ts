/**
 * v12 2.2 / Tier 7B — file-based, BLOCKING workspace hooks
 * (`.atlarix/hooks/hooks.json`).
 *
 * Replaces (alongside, for now) the DB-stored advisory hooks-manager: these
 * hooks travel with the repo, and a blocking `pre_tool_use` hook can DENY a
 * tool; a `stop` hook can block `<task_complete>` until it exits 0 (e.g.
 * "require tests before done"). Lean by design: shell + globs, no AI.
 *
 *   // .atlarix/hooks/hooks.json
 *   { "hooks": [
 *       { "trigger": "pre_tool_use", "match": "write_file(src/db/*)",
 *         "command": "./scripts/check-migrations.sh", "blocking": true },
 *       { "trigger": "stop", "command": "npm test --silent" }
 *   ] }
 *
 * - `match` uses the permission-ruleset pattern syntax (tool(glob) / bare
 *   tool glob); omitted = matches every tool. Ignored for `stop`.
 * - `pre_tool_use` + `blocking:true` (default true): non-zero exit denies
 *   the tool; the model sees a structured error with the stderr tail.
 * - `post_tool_use`: advisory, fire-and-forget (parity with the legacy DB
 *   hooks' after_* triggers).
 * - `stop`: blocking gate on task completion; non-zero exit feeds the
 *   stderr/stdout tail back into the loop (bounded by the engine's
 *   suppression counter — a permanently red gate cannot wedge a turn).
 * - Hooks run with cwd = workspace root and env ATLARIX_TOOL /
 *   ATLARIX_TARGET / ATLARIX_TRIGGER; 20s default timeout.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import log from "electron-log";
import { compileRule, ruleMatchTarget } from "@/lib/tools/permissions/ruleset";

const logger = log.scope("file-hooks");

export type FileHookTrigger = "pre_tool_use" | "post_tool_use" | "stop";

export interface FileHook {
  trigger: FileHookTrigger;
  /** tool(glob) / bare tool glob — permission-ruleset syntax. */
  match?: string;
  command: string;
  blocking?: boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const OUTPUT_TAIL_CHARS = 600;

const cache = new Map<string, { mtimeMs: number; hooks: FileHook[] }>();

export function hooksPathFor(workspacePath: string): string {
  return path.join(workspacePath, ".atlarix", "hooks", "hooks.json");
}

export function loadWorkspaceHooks(workspacePath: string): FileHook[] {
  const file = hooksPathFor(workspacePath);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    cache.delete(file);
    return [];
  }
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.hooks;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      hooks?: unknown[];
    };
    const hooks = (Array.isArray(parsed.hooks) ? parsed.hooks : []).filter(
      (h): h is FileHook =>
        !!h &&
        typeof h === "object" &&
        typeof (h as FileHook).command === "string" &&
        ["pre_tool_use", "post_tool_use", "stop"].includes(
          (h as FileHook).trigger,
        ),
    );
    cache.set(file, { mtimeMs, hooks });
    logger.log(`Loaded ${hooks.length} workspace hook(s) from ${file}`);
    return hooks;
  } catch (e) {
    logger.warn(`Failed to parse ${file}: ${String(e)} — no hooks`);
    cache.delete(file);
    return [];
  }
}

interface HookRunResult {
  ok: boolean;
  outputTail: string;
}

function runHookCommand(
  hook: FileHook,
  workspacePath: string,
  env: Record<string, string>,
): Promise<HookRunResult> {
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", hook.command],
      {
        cwd: workspacePath,
        timeout: hook.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: { ...process.env, ...env },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const tail = `${stderr || ""}\n${stdout || ""}`
          .trim()
          .slice(-OUTPUT_TAIL_CHARS);
        resolve({ ok: error == null, outputTail: tail });
      },
    );
  });
}

function hookMatchesTool(
  hook: FileHook,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  if (!hook.match) return true;
  const rule = compileRule(hook.match);
  if (!rule) return false;
  const target = ruleMatchTarget(toolName, args);
  if (!rule.toolGlob.test(toolName)) return false;
  return rule.targetGlob == null || rule.targetGlob.test(target);
}

/**
 * Run matching pre_tool_use hooks. Returns a denial (with output tail) when
 * a BLOCKING hook exits non-zero; null = proceed. post_tool_use advisories
 * for the same tool fire after execution via runPostToolUseHooks.
 */
export async function runPreToolUseHooks(
  workspacePath: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ deniedBy: string; outputTail: string } | null> {
  const hooks = loadWorkspaceHooks(workspacePath).filter(
    (h) => h.trigger === "pre_tool_use" && hookMatchesTool(h, toolName, args),
  );
  for (const hook of hooks) {
    const res = await runHookCommand(hook, workspacePath, {
      ATLARIX_TRIGGER: "pre_tool_use",
      ATLARIX_TOOL: toolName,
      ATLARIX_TARGET: ruleMatchTarget(toolName, args),
    });
    if (!res.ok && hook.blocking !== false) {
      logger.warn(`pre_tool_use hook denied ${toolName}: ${hook.command}`);
      return { deniedBy: hook.command, outputTail: res.outputTail };
    }
  }
  return null;
}

/** Fire-and-forget advisories after a tool executed. */
export function runPostToolUseHooks(
  workspacePath: string,
  toolName: string,
  args: Record<string, unknown>,
): void {
  const hooks = loadWorkspaceHooks(workspacePath).filter(
    (h) => h.trigger === "post_tool_use" && hookMatchesTool(h, toolName, args),
  );
  for (const hook of hooks) {
    void runHookCommand(hook, workspacePath, {
      ATLARIX_TRIGGER: "post_tool_use",
      ATLARIX_TOOL: toolName,
      ATLARIX_TARGET: ruleMatchTarget(toolName, args),
    }).then((res) => {
      if (!res.ok) {
        logger.warn(`post_tool_use hook failed (advisory): ${hook.command}`);
      }
    });
  }
}

/** True when the workspace declares any stop hooks (cheap pre-check). */
export function hasStopHooks(workspacePath: string): boolean {
  return loadWorkspaceHooks(workspacePath).some((h) => h.trigger === "stop");
}

/**
 * Run stop hooks (the "require X before done" gate). Returns feedback text
 * when a hook exits non-zero — the engine suppresses <task_complete> and
 * feeds this back (bounded); null = all gates green.
 */
export async function runStopHooks(
  workspacePath: string,
): Promise<string | null> {
  const hooks = loadWorkspaceHooks(workspacePath).filter(
    (h) => h.trigger === "stop",
  );
  for (const hook of hooks) {
    const res = await runHookCommand(hook, workspacePath, {
      ATLARIX_TRIGGER: "stop",
    });
    if (!res.ok) {
      logger.log(`stop hook blocked task completion: ${hook.command}`);
      return [
        `A workspace stop-hook (\`${hook.command}\`) is failing — the task is not complete until it passes:`,
        "",
        res.outputTail || "(no output)",
      ].join("\n");
    }
  }
  return null;
}
