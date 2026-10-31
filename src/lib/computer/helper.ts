/**
 * The computer-use executor: one `atlarix-computer` child per process, spoken
 * to in JSON lines (native/atlarix-computer/src/main.rs has the protocol).
 *
 * Both lanes (the provider's own computer tool and ours) end up here, from the
 * app, the CLI and ACP alike. Errors keep the helper's own code and message:
 * "busy", "permission" and "user_took_control" each mean something different to
 * the caller, and a generic failure would hide which.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { unpackEmbeddedBinary } from "@/runtime/embedded-bin";

export type HelperOp =
  | "permissions"
  | "reset"
  | "release"
  | "display"
  | "screenshot"
  | "click"
  | "move"
  | "drag"
  | "type"
  | "key"
  | "scroll"
  | "cursor"
  | "button";

export type HelperReply = { ok: true; [k: string]: unknown };

export class HelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HelperError";
  }
}

const NAME = process.platform === "win32" ? "atlarix-computer.exe" : "atlarix-computer";
/** Typing a long text is the slowest op; a stuck helper must still surface. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Dev fallback: the executor built from source. Resolved from the CLI binary's
 * own directory (dist-bun/ → one up → project root) and from __dirname (for
 * running under tsx/Node), NOT from process.cwd(). The working directory
 * changes with `start-atlarix.sh` and user shells, so a CWD-relative lookup
 * silently made computer use unavailable unless the user happened to launch
 * from the project root (0n).
 */
function devExecutorPath(): string | null {
  const rel = path.join("native", "atlarix-computer", "target", "release", NAME);
  // Compiled CLI: process.execPath IS the binary (dist-bun/atlarix); one up is
  // the project root (Atlarix/).
  const fromBin = path.resolve(path.dirname(process.execPath), "..", rel);
  if (fs.existsSync(fromBin)) return fromBin;
  // Dev under Node/tsx: __dirname is src/lib/computer/; three up is the project root.
  const fromSrc = path.resolve(__dirname, "..", "..", "..", rel);
  if (fs.existsSync(fromSrc)) return fromSrc;
  return null;
}

/** The binary, or null when this build does not carry one. */
export async function resolveHelperPath(): Promise<string | null> {
  const override = process.env.ATLARIX_COMPUTER_HELPER;
  if (override && fs.existsSync(override)) return override;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, NAME);
    if (fs.existsSync(packaged)) return packaged;
  }
  const embedded = await unpackEmbeddedBinary(NAME, process.env.ATLARIX_EMBEDDED_COMPUTER);
  if (embedded) return embedded;
  return devExecutorPath();
}

/**
 * Whether this build carries the executor at all (sync, for the toolset gate):
 * without one every action would fail with "missing", so the model is not
 * offered the tool. Same places resolveHelperPath looks.
 */
export function helperPresent(): boolean {
  const override = process.env.ATLARIX_COMPUTER_HELPER;
  if (override && fs.existsSync(override)) return true;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath && fs.existsSync(path.join(resourcesPath, NAME))) return true;
  const embedded = process.env.ATLARIX_EMBEDDED_COMPUTER;
  if (embedded) return true;
  return devExecutorPath() !== null;
}

type Pending = {
  resolve: (r: HelperReply) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let child: ChildProcessWithoutNullStreams | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function failAll(err: Error): void {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
}

async function ensureChild(): Promise<ChildProcessWithoutNullStreams> {
  if (child) return child;
  const bin = await resolveHelperPath();
  if (!bin) {
    throw new HelperError("unavailable", "Computer use is unavailable: the atlarix-computer executor is not included in this build.");
  }
  const c = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child = c;
  let stderr = "";
  c.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });
  readline.createInterface({ input: c.stdout }).on("line", (line) => {
    let msg: { id?: number; ok?: boolean; code?: string; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const p = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
    if (!p) return;
    pending.delete(msg.id!);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg as HelperReply);
    else p.reject(new HelperError(msg.code ?? "failed", msg.error ?? "computer use failed"));
  });
  const gone = (why: string) => {
    // A child we already replaced (stopHelper) must not fail the new one's requests.
    if (child !== c) return;
    child = null;
    failAll(new HelperError("failed", `atlarix-computer ${why}${stderr ? `: ${stderr.trim()}` : ""}`));
  };
  c.on("error", (e) => gone(`could not start (${e.message})`));
  c.on("exit", (code, signal) => gone(`exited (${signal ?? code})`));
  // Never keep the host alive for the helper; it exits when stdin closes. A
  // request in flight still holds the loop through its timeout timer.
  c.unref();
  for (const s of [c.stdin, c.stdout, c.stderr]) (s as unknown as { unref?: () => void }).unref?.();
  return c;
}

export async function helperRequest(
  op: HelperOp,
  args: Record<string, unknown> = {},
): Promise<HelperReply> {
  const c = await ensureChild();
  const id = nextId++;
  return new Promise<HelperReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new HelperError("timeout", `atlarix-computer did not answer "${op}" in ${REQUEST_TIMEOUT_MS / 1000}s`));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    c.stdin.write(`${JSON.stringify({ ...args, id, op })}\n`);
  });
}

/** End the helper (and with it the screen lock). Safe to call at any time. */
export function stopHelper(): void {
  const c = child;
  child = null;
  failAll(new HelperError("stopped", "computer use was stopped"));
  if (c) {
    c.stdin.end();
    c.kill();
  }
}
