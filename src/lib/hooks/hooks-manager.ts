/**
 * Advisory hooks: run user-defined commands around file writes and shell commands.
 * Failures are logged only; never thrown to callers.
 */

import { spawn } from "node:child_process";
import log from "electron-log";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { atlarixHooks } from "@/db/schema";

const logger = log.scope("hooks-manager");

const HOOK_TIMEOUT_MS = 30_000;

export type HookTrigger =
  | "before_file_write"
  | "after_file_write"
  | "before_run_command"
  | "after_run_command";

function parseArgsJson(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function runOneHookProcess(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(params.command, params.args, {
      env: params.env,
      shell: false,
      stdio: "ignore",
    });
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 2000);
      } catch {
        /* ignore */
      }
    }, HOOK_TIMEOUT_MS);
    child.on("close", () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.on("error", (err) => {
      clearTimeout(killTimer);
      logger.warn("[hooks] spawn error:", err);
      resolve();
    });
  });
}

/**
 * Load enabled hooks for `trigger` matching global (no workspace) or `workspaceId`, then run sequentially.
 */
export async function runHooksForTrigger(params: {
  trigger: HookTrigger;
  workspacePath: string;
  workspaceId: number | null;
  extraEnv?: Record<string, string>;
}): Promise<void> {
  try {
    const wid = params.workspaceId;
    const scope =
      wid != null
        ? or(isNull(atlarixHooks.workspaceId), eq(atlarixHooks.workspaceId, wid))
        : isNull(atlarixHooks.workspaceId);
    const rows = await db
      .select()
      .from(atlarixHooks)
      .where(
        and(eq(atlarixHooks.enabled, true), eq(atlarixHooks.trigger, params.trigger), scope),
      );

    if (rows.length === 0) return;

    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ATLARIX_WORKSPACE_PATH: params.workspacePath,
      ATLARIX_WORKSPACE_ID: wid != null ? String(wid) : "",
      ATLARIX_TRIGGER: params.trigger,
      ...params.extraEnv,
    };

    for (const row of rows) {
      const args = parseArgsJson(row.argsJson);
      baseEnv.ATLARIX_HOOK_ID = String(row.id);
      baseEnv.ATLARIX_HOOK_NAME = row.name;
      try {
        await runOneHookProcess({
          command: row.command,
          args,
          env: { ...baseEnv },
        });
      } catch (e) {
        logger.warn(`[hooks] hook id=${row.id} name=${row.name}:`, e);
      }
    }
  } catch (e) {
    logger.warn("[hooks] runHooksForTrigger failed:", e);
  }
}
