/**
 * wrap-command.ts — free, per-OS write-confining sandbox for agent `run_command`.
 *
 * Policy: confine file WRITES to the workspace + temp + common package caches;
 * deny writes elsewhere; reads stay broad; NETWORK STAYS ON (so npm/pip/git work).
 *
 * - macOS:   `sandbox-exec` (Seatbelt) — built-in, free.
 * - Linux:   `bwrap` (bubblewrap) — free; falls back if not installed.
 * - Windows: `atlarix-sandbox.exe` AppContainer helper — falls back if not bundled.
 *
 * Applies ONLY to agent `run_command`. The user's interactive PTY tabs are never
 * sandboxed. On any failure the caller runs the command unsandboxed (unless the
 * caller is in `enforce` mode), so the sandbox can never break a user's workflow.
 */

import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import log from "electron-log";

const logger = log.scope("command-sandbox");

export interface SandboxRequest {
  /** The shell command string to run (as the model wrote it). */
  command: string;
  /** Resolved shell binary, e.g. /bin/zsh. The command runs as `<shell> -c <command>`. */
  shell: string;
  /** Workspace root — granted write access. */
  workspacePath: string;
  /** Extra absolute paths to allow writes to (from settings). */
  extraWritablePaths?: string[];
}

export interface WrappedSpawn {
  /** Executable to spawn. When `sandboxed` is false this is the shell. */
  file: string;
  /** Arguments (array form — no shell-quoting needed). */
  args: string[];
  /** Whether the command is actually confined. */
  sandboxed: boolean;
  /** True when the spawn must go through Node's `shell:` option (unsandboxed path). */
  useShellOption: boolean;
  /** Human-readable reason when not sandboxed. */
  note?: string;
}

/** Realpath a dir if it exists; return null otherwise (so we never bind a missing path). */
function realIfExists(p: string): string | null {
  try {
    if (!existsSync(p)) return null;
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** Common package-manager / toolchain cache dirs that legitimately need writes. */
function defaultWritablePaths(workspacePath: string, extra: string[] = []): string[] {
  const home = os.homedir();
  const tmp = os.tmpdir();
  const candidates = [
    workspacePath,
    tmp,
    "/tmp",
    "/private/tmp",
    "/var/folders", // macOS per-user temp root
    path.join(home, ".npm"),
    path.join(home, ".cache"),
    path.join(home, ".config"),
    path.join(home, ".yarn"),
    path.join(home, ".pnpm-store"),
    path.join(home, ".bun"),
    path.join(home, ".deno"),
    path.join(home, ".cargo"),
    path.join(home, ".rustup"),
    path.join(home, ".gradle"),
    path.join(home, ".m2"),
    path.join(home, ".gem"),
    path.join(home, ".local", "share"),
    path.join(home, ".local", "state"),
    path.join(home, "go", "pkg"),
    path.join(home, "Library", "Caches"), // macOS
    ...extra,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    const real = realIfExists(c);
    if (real && !seen.has(real)) {
      seen.add(real);
      out.push(real);
    }
  }
  return out;
}

// ── macOS (Seatbelt) ─────────────────────────────────────────────────────────

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function buildSeatbeltProfile(writable: string[]): string {
  // Last matching rule wins in SBPL: allow-all, then deny writes, then re-allow
  // writes to the confined set. Network is left allowed by `(allow default)`.
  const allows = writable.map((p) => `  (subpath ${JSON.stringify(p)})`).join("\n");
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    allows,
    `  (subpath "/dev")`, // /dev/null, /dev/tty, etc.
    ")",
  ].join("\n");
}

function wrapMacos(req: SandboxRequest, writable: string[]): WrappedSpawn | null {
  if (!existsSync(SANDBOX_EXEC)) {
    return null;
  }
  const profile = buildSeatbeltProfile(writable);
  return {
    file: SANDBOX_EXEC,
    args: ["-p", profile, req.shell, "-c", req.command],
    sandboxed: true,
    useShellOption: false,
  };
}

// ── Linux (bubblewrap) ─────────────────────────────────────────────────────────

function findBwrap(): string | null {
  for (const p of ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"]) {
    if (existsSync(p)) return p;
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "bwrap");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function wrapLinux(req: SandboxRequest, writable: string[]): WrappedSpawn | null {
  const bwrap = findBwrap();
  if (!bwrap) return null;

  // Read-only root, writable temp + the confined set. Network is NOT unshared, so
  // it stays available. `--bind-try` skips paths that don't exist.
  const args: string[] = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--die-with-parent",
  ];
  for (const p of writable) {
    args.push("--bind-try", p, p);
  }
  args.push(req.shell, "-c", req.command);
  return { file: bwrap, args, sandboxed: true, useShellOption: false };
}

// ── Windows (AppContainer helper) ────────────────────────────────────────────

/**
 * Resolve the bundled AppContainer helper. Not present in this build — when a
 * future build bundles `atlarix-sandbox.exe` next to the app resources, point
 * this at it. Contract (planned):
 *   atlarix-sandbox.exe --workspace <dir> [--writable <dir>]... -- <command>
 * The helper creates an AppContainer profile with write-ACLs on the writable
 * set + the `internetClient` capability and runs the command inside it.
 */
function findWindowsHelper(): string | null {
  const fromEnv = process.env.ATLARIX_SANDBOX_HELPER;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    // process.resourcesPath exists in packaged Electron apps.
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) {
      const candidate = path.join(resourcesPath, "atlarix-sandbox.exe");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function wrapWindows(req: SandboxRequest, writable: string[]): WrappedSpawn | null {
  const helper = findWindowsHelper();
  if (!helper) return null;
  const args = ["--workspace", req.workspacePath];
  for (const p of writable) args.push("--writable", p);
  args.push("--", req.command);
  return { file: helper, args, sandboxed: true, useShellOption: false };
}

// ── Entry ─────────────────────────────────────────────────────────────────────

/**
 * Build a sandboxed spawn for `req`. Returns a `sandboxed: false` descriptor
 * (the shell run unchanged) when no free sandbox is available on this platform —
 * the command still runs, just unconfined, and the caller logs a warning.
 */
export function wrapCommandInSandbox(req: SandboxRequest): WrappedSpawn {
  const workspaceReal = realIfExists(req.workspacePath) ?? req.workspacePath;
  const writable = defaultWritablePaths(workspaceReal, req.extraWritablePaths);

  let wrapped: WrappedSpawn | null = null;
  let unavailableNote = "";
  switch (process.platform) {
    case "darwin":
      wrapped = wrapMacos(req, writable);
      unavailableNote = "sandbox-exec not found";
      break;
    case "linux":
      wrapped = wrapLinux(req, writable);
      unavailableNote = "bubblewrap (bwrap) not installed";
      break;
    case "win32":
      wrapped = wrapWindows(req, writable);
      unavailableNote = "AppContainer helper (atlarix-sandbox.exe) not bundled";
      break;
    default:
      unavailableNote = `no sandbox for platform ${process.platform}`;
  }

  if (wrapped) {
    logger.debug(`Sandboxing run_command (${process.platform}); ${writable.length} writable roots`);
    return wrapped;
  }

  return {
    file: req.shell,
    args: ["-c", req.command],
    sandboxed: false,
    useShellOption: true,
    note: unavailableNote,
  };
}
