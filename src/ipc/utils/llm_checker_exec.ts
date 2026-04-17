/**
 * Invoke global `llm-checker` CLI via child process only (Electron main).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LLM_CHECKER_ENV = {
  ...process.env,
  NO_COLOR: "1",
  NO_INTERACTIVE: "1",
} as const;

const MAX_BUFFER = 20 * 1024 * 1024;

function formatExecError(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; stdout?: Buffer | string };
  let stderr = "";
  if (typeof e.stderr === "string") stderr = e.stderr;
  else if (Buffer.isBuffer(e.stderr)) stderr = e.stderr.toString("utf-8");
  else if (e.stderr != null) stderr = String(e.stderr);
  const hint = stderr.trim().slice(0, 500);
  return hint ? `${e.message ?? String(err)} — ${hint}` : e.message ?? String(err);
}

export async function runLlmChecker(
  args: string[],
  options?: { timeoutMs?: number },
): Promise<string> {
  const timeout = options?.timeoutMs ?? 30_000;
  try {
    const { stdout } = await execFileAsync("llm-checker", args, {
      timeout,
      env: { ...LLM_CHECKER_ENV },
      maxBuffer: MAX_BUFFER,
    });
    const out = stdout as string | Buffer;
    if (typeof out === "string") return out;
    if (Buffer.isBuffer(out)) return out.toString("utf-8");
    return String(out ?? "");
  } catch (err) {
    throw new Error(`llm-checker failed: ${formatExecError(err)}`);
  }
}

let availabilityCache: { at: number; value: boolean } | null = null;
const AVAILABILITY_TTL_MS = 60_000;

export async function isLlmCheckerAvailable(): Promise<boolean> {
  const now = Date.now();
  if (availabilityCache && now - availabilityCache.at < AVAILABILITY_TTL_MS) {
    return availabilityCache.value;
  }
  try {
    await execFileAsync("llm-checker", ["--version"], {
      timeout: 5000,
      env: { ...LLM_CHECKER_ENV },
      maxBuffer: 1024 * 1024,
    });
    availabilityCache = { at: now, value: true };
    return true;
  } catch {
    availabilityCache = { at: now, value: false };
    return false;
  }
}
