/**
 * wrap-command.ts — free, per-OS write-confining sandbox for agent `run_command`.
 *
 * Policy: confine file WRITES to the workspace + temp + common package caches;
 * deny writes elsewhere; reads stay broad; NETWORK STAYS ON (so npm/pip/git work).
 *
 * - macOS:   `sandbox-exec` (Seatbelt) — built-in, free.
 * - Linux:   bundled `atlarix-sandbox-linux` (Landlock) helper; falls back to an
 *            OS-installed `bwrap` (bubblewrap), then unsandboxed.
 * - Windows: `atlarix-sandbox.exe` AppContainer helper — falls back if not bundled.
 *
 * Applies ONLY to agent `run_command`. The user's interactive PTY tabs are never
 * sandboxed. On any failure the caller runs the command unsandboxed (unless the
 * caller is in `enforce` mode), so the sandbox can never break a user's workflow.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import log from "electron-log";
import { wrapWsl } from "./wsl";

const logger = log.scope("command-sandbox");

export interface SandboxRequest {
  /** The shell command string to run (as the model wrote it). */
  command: string;
  /** Resolved shell binary, e.g. /bin/zsh. The command runs as `<shell> -c <command>`. */
  shell: string;
  /** Workspace root — granted write access (unless `readOnly`). */
  workspacePath: string;
  /** Extra absolute paths to allow writes to (from settings). */
  extraWritablePaths?: string[];
  /**
   * Read-only mode (Explore/Plan/Review): the command can read anything but the
   * WORKSPACE (and extra paths) are NOT writable — only /tmp + toolchain caches +
   * /dev. A write to the source fails cleanly at the OS layer instead of being
   * pre-blocked by a command classifier.
   */
  readOnly?: boolean;
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

/**
 * Resolve a WRITE-intent candidate (a toolchain cache or an escalation-granted
 * path) to a canonical absolute path for the sandbox grant — even when it does
 * not exist yet. This fixes the chicken-and-egg where a cache dir a tool is
 * about to create (`~/.yarn`) was pruned because it didn't exist, so its grant
 * was never emitted and the tool's first `mkdir` was denied.
 *
 * - Existing path → realpath (symlink-safe, dedups).
 * - Missing path:
 *   • `createMissing` (Linux/Windows — Landlock's `path_beneath_rules` opens an
 *     fd and the Windows helper's `GetNamedSecurityInfoW` both need a real path):
 *     `mkdir -p` then realpath. Best-effort; returns null if creation fails.
 *   • otherwise (macOS Seatbelt accepts a *prospective* `(subpath …)`): realpath
 *     the nearest EXISTING ancestor and re-append the missing tail — no dir is
 *     created, and symlinks in the existing prefix stay resolved.
 */
function resolveWritablePath(p: string, createMissing: boolean): string | null {
  try {
    if (existsSync(p)) return realpathSync(p);
  } catch {
    /* fall through to the missing-path handling */
  }
  if (createMissing) {
    try {
      mkdirSync(p, { recursive: true });
      return realpathSync(p);
    } catch {
      return null;
    }
  }
  // Prospective (macOS): realpath the nearest existing ancestor + missing tail.
  try {
    let ancestor = path.dirname(p);
    const tail: string[] = [path.basename(p)];
    while (ancestor !== path.dirname(ancestor) && !existsSync(ancestor)) {
      tail.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
    if (!existsSync(ancestor)) return null;
    return path.join(realpathSync(ancestor), ...tail);
  } catch {
    return null;
  }
}

/**
 * Standard env vars each toolchain reads to locate its store/cache BEFORE
 * falling back to a default dir. Honoring these keeps the writable set dynamic —
 * a user's custom location (custom PNPM_HOME, CARGO_HOME, GOPATH, XDG_*, …) is
 * covered without hardcoding, and no command name is ever matched. The sandbox
 * stays a generic write boundary, not a per-command allow-list.
 */
const TOOLCHAIN_DIR_ENV_VARS = [
  "PNPM_HOME", // pnpm
  "npm_config_cache", // npm
  "YARN_CACHE_FOLDER", // yarn
  "BUN_INSTALL", // bun
  "DENO_DIR", // deno
  "CARGO_HOME", // cargo
  "RUSTUP_HOME", // rustup
  "GRADLE_USER_HOME", // gradle
  "GOPATH", // go
  "GOMODCACHE", // go module cache
  "GOCACHE", // go build cache
  "GEM_HOME", // ruby gems
  "XDG_CACHE_HOME", // freedesktop cache root
  "XDG_DATA_HOME", // freedesktop data root
  "XDG_STATE_HOME", // freedesktop state root
  "XDG_CONFIG_HOME", // freedesktop config root
] as const;

/**
 * Common package-manager / toolchain cache dirs that legitimately need writes.
 *
 * Two classes of candidate:
 *  - **bind-must-exist** (workspace, temp roots, env-derived dirs): granted only
 *    when they already exist — never created — matching bwrap's `--bind-try`.
 *  - **grantable-even-if-missing** (the curated home-cache list + escalation/
 *    settings `extra` paths): resolved via `resolveWritablePath` so a cache dir a
 *    tool is about to create is granted anyway. `createMissingCaches` (Linux/
 *    Windows) `mkdir -p`s them; macOS emits a prospective subpath (see helper).
 */
function defaultWritablePaths(
  workspacePath: string,
  extra: string[] = [],
  createMissingCaches = false,
): string[] {
  const home = os.homedir();
  const tmp = os.tmpdir();
  // Env-configured toolchain dirs first (dynamic); realIfExists dedups + prunes.
  const envDirs = TOOLCHAIN_DIR_ENV_VARS.map((v) => process.env[v]).filter(
    (p): p is string => !!p && p.length > 0,
  );
  // Granted only if they already exist (existence = intent that they're real).
  const mustExist = [
    workspacePath,
    tmp,
    "/tmp",
    "/private/tmp",
    "/var/folders", // macOS per-user temp root
    ...envDirs,
  ];
  // Write-intent dirs granted even when missing (curated caches + escalation/
  // settings extras): a first run must be able to CREATE its own cache dir.
  const grantable = [
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
    path.join(home, "Library", "pnpm"), // pnpm's default PNPM_HOME on macOS (store lives here)
    ...extra,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (resolved: string | null) => {
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  };
  for (const c of mustExist) add(realIfExists(c));
  for (const c of grantable) add(resolveWritablePath(c, createMissingCaches));
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

/**
 * Resolve the bundled Landlock helper (`atlarix-sandbox-linux`, built from
 * native/atlarix-sandbox-linux in the Linux CI job). Self-contained — no OS
 * dependency, unlike bwrap. Falls back to bwrap when absent (e.g. a dev build
 * without the compiled helper). Override with ATLARIX_SANDBOX_HELPER_LINUX.
 */
function findLinuxHelper(): string | null {
  const fromEnv = process.env.ATLARIX_SANDBOX_HELPER_LINUX;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) {
      const candidate = path.join(resourcesPath, "atlarix-sandbox-linux");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function wrapLinux(req: SandboxRequest, writable: string[]): WrappedSpawn | null {
  // Prefer the bundled Landlock helper (self-contained); same CLI contract as the
  // Windows helper: --workspace <dir> [--writable <dir>]... -- <cmd>.
  const helper = findLinuxHelper();
  if (helper) {
    const args = ["--workspace", req.workspacePath];
    if (req.readOnly) args.push("--read-only"); // deny workspace writes
    for (const p of writable) args.push("--writable", p);
    // Pass the RESOLVED shell. The helper used to hardcode `/bin/sh`, so a command
    // using bashisms worked unsandboxed and failed sandboxed — the sandbox was
    // changing language semantics, not just permissions.
    args.push("--shell", req.shell);
    args.push("--", req.command);
    return { file: helper, args, sandboxed: true, useShellOption: false };
  }
  // Fallback: OS-installed bubblewrap.
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

// ── Windows (Low Integrity Level helper) ─────────────────────────────────────

/**
 * Resolve the bundled helper (`atlarix-sandbox.exe`, cargo-built + signed in the
 * Windows CI job, shipped via forge.config.ts `extraResource`). Resolves at
 * runtime from `process.resourcesPath`; override with ATLARIX_SANDBOX_HELPER.
 * Contract:
 *   atlarix-sandbox.exe --workspace <dir> [--writable <dir>]... -- <command>
 * The helper runs the command under a Low-integrity token, stamping a Low
 * mandatory label on the writable set so writes there are allowed while reads and
 * exec stay unrestricted. Falls back to unsandboxed when absent (e.g. a build
 * where the crate didn't compile).
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

/**
 * `null` until probed, then the cached verdict for this session.
 * Exported reset exists only for tests.
 */
let windowsHelperUsable: boolean | null = null;

export function resetWindowsSandboxProbeForTests(): void {
  windowsHelperUsable = null;
}

/**
 * Does the Low-IL mechanism actually work on THIS machine?
 *
 * `CreateProcessAsUserW` is documented as needing `SE_ASSIGNPRIMARYTOKEN_NAME`
 * when the token "is not assignable". A lowered duplicate of our own token should
 * be assignable (this is how Chrome sandboxes renderers on standard accounts), but
 * a locked-down or EDR-managed machine can still refuse it — so we ask once rather
 * than assume.
 *
 * Deliberately a SYNTHETIC probe run before any user command, not a retry after a
 * user command fails. Retry-on-denial would downgrade to unsandboxed on exactly
 * the commands that matter and could be triggered on purpose by a crafted command;
 * a probe cannot be influenced that way.
 */
function windowsSandboxUsable(helper: string): boolean {
  if (windowsHelperUsable !== null) return windowsHelperUsable;
  try {
    const probe = spawnSync(helper, ["--probe"], { timeout: 15_000, windowsHide: true });
    windowsHelperUsable = probe.status === 0;
    if (!windowsHelperUsable) {
      logger.warn(
        `Windows sandbox self-probe FAILED (status=${probe.status}); run_command will be ` +
          `unconfined on this machine. ${(probe.stderr?.toString() ?? "").trim().slice(0, 300)}`,
      );
    }
  } catch (e) {
    windowsHelperUsable = false;
    logger.warn(`Windows sandbox self-probe could not run: ${e instanceof Error ? e.message : String(e)}`);
  }
  return windowsHelperUsable;
}

function wrapWindows(req: SandboxRequest, writable: string[]): WrappedSpawn | null {
  const helper = findWindowsHelper();
  if (!helper) return null;
  if (!windowsSandboxUsable(helper)) return null;
  const args = ["--workspace", req.workspacePath];
  if (req.readOnly) args.push("--read-only"); // deny workspace writes
  for (const p of writable) args.push("--writable", p);
  // Same shell the unsandboxed path uses. On Windows `getAcceptableShell()` prefers
  // Git bash when it's installed, while the helper used to hardcode `cmd.exe /c` —
  // so POSIX-shaped commands failed under the sandbox with cmd syntax errors that
  // looked like sandbox denials but weren't.
  args.push("--shell", req.shell);
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
  // macOS Seatbelt grants a prospective (subpath …) for a not-yet-created cache
  // dir; Landlock (Linux) / AppContainer ACLs (Windows) need the path to exist,
  // so there we create the curated caches first (see resolveWritablePath).
  const createMissingCaches = process.platform !== "darwin";
  // Read-only: writable = only toolchain caches + /tmp (+ /dev), NOT the workspace
  // or extra paths. Passing "" as the workspace drops it from the candidate set.
  const writable = req.readOnly
    ? defaultWritablePaths("", [], createMissingCaches)
    : defaultWritablePaths(workspaceReal, req.extraWritablePaths, createMissingCaches);

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
    case "win32": {
      // A workspace under \\wsl$\… is a Linux project with a Linux toolchain, so
      // route into the distro rather than confining it Windows-side. Checked FIRST
      // because Low IL would otherwise confine the wrong filesystem. Plain C:\…
      // workspaces fall straight through to the Windows helper.
      const viaWsl = wrapWsl({
        workspacePath: req.workspacePath,
        shell: req.shell,
        command: req.command,
        extraWritablePaths: req.extraWritablePaths,
        readOnly: req.readOnly,
      });
      if (viaWsl) {
        if (viaWsl.sandboxed) {
          logger.info(`Sandboxing run_command via WSL (bwrap) for ${req.workspacePath}`);
          return { file: viaWsl.file, args: viaWsl.args, sandboxed: true, useShellOption: false };
        }
        // Routed into the distro but unconfined: still the right OS to run in, so
        // report it as unsandboxed and let the caller's enforce/warn path decide.
        return {
          file: viaWsl.file,
          args: viaWsl.args,
          sandboxed: false,
          useShellOption: false,
          note: viaWsl.note,
        };
      }
      wrapped = wrapWindows(req, writable);
      unavailableNote =
        "Low-integrity helper (atlarix-sandbox.exe) not bundled, or its self-probe failed on this machine";
      break;
    }
    default:
      unavailableNote = `no sandbox for platform ${process.platform}`;
  }

  if (wrapped) {
    // INFO, not debug: a write-confining control that degrades silently must be
    // affirmatively observable. Previously only its FAILURE was logged (at warn),
    // so "the sandbox is on" could only ever be inferred from the absence of a
    // warning — which is how a broken Windows sandbox went unnoticed for releases.
    logger.info(`Sandboxing run_command (${process.platform}); ${writable.length} writable roots`);
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

// ── Denial capture (escalation-on-denial) ────────────────────────────────────

export interface SandboxDenial {
  /** The exact path the OS denied a write to (as the failing tool reported it). */
  deniedPath: string;
  /** The directory to grant sandbox write access to so a retry succeeds. */
  grantPath: string;
}

/** A broad root we must never grant wholesale (grant the denied leaf instead). */
function isBroadRoot(dir: string): boolean {
  const norm = dir.replace(/[/\\]+$/, "");
  if (!norm) return true;
  let home = "";
  try {
    home = os.homedir().replace(/[/\\]+$/, "");
  } catch {
    /* ignore */
  }
  if (home && norm === home) return true;
  // Filesystem root or a direct child of it (/, /Users, /home, /var, C:\, C:\Users).
  const depth = norm.split(/[/\\]+/).filter(Boolean).length;
  return depth <= 1;
}

/**
 * Path to grant for a denied write: the parent directory, unless that parent is
 * a broad root (e.g. `$HOME`), in which case grant the denied leaf itself — so a
 * `mkdir ~/.yarn` denial grants `~/.yarn`, never all of `$HOME`.
 */
export function sandboxGrantPath(deniedPath: string): string {
  const parent = path.dirname(deniedPath);
  if (!parent || parent === deniedPath || isBroadRoot(parent)) return deniedPath;
  return parent;
}

const DENIAL_PATTERNS: RegExp[] = [
  // Node/libuv: `EACCES: permission denied, open '/path'` / `EPERM: …, mkdir 'C:\path'`
  /E(?:PERM|ACCES):[^,\n]*,\s*\w+\s+['"]([^'"\n]+)['"]/g,
  // GNU coreutils: `cannot create directory ‘/path’: Permission denied` (straight
  // or fancy ‘ ’ quotes — include BOTH U+2018 and U+2019).
  /cannot (?:create|touch|remove|open)[^'‘’"\n]*['‘’"]([^'‘’"\n]+)['‘’"]:\s*Permission denied/g,
  // BSD/macOS + generic: `mkdir: /path: Operation not permitted` / `: /path: Permission denied`
  /:\s*((?:\/|[A-Za-z]:\\)[^:\n]+):\s*(?:Operation not permitted|Permission denied)/g,
];

/**
 * Best-effort extraction of sandbox WRITE denials from a failed command's output.
 * The OS returns EPERM/EACCES to the failing tool, which prints the offending
 * path — exactly how `yarn`'s `EPERM … mkdir '~/.yarn'` surfaced. Used on
 * macOS/Windows, and on Linux until the ptrace report lands (Phase 2; macOS does
 * NOT log custom sandbox-exec denials to the unified log — verified). Returns
 * distinct denials in first-seen order; `[]` when nothing is parseable.
 */
export function parseSandboxDenialsFromOutput(output: string): SandboxDenial[] {
  if (!output) return [];
  const seen = new Set<string>();
  const out: SandboxDenial[] = [];
  for (const re of DENIAL_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(output)) !== null) {
      const deniedPath = (m[1] ?? "").trim();
      // Absolute paths only (posix `/…`, Windows `C:\…` or UNC `\\…`).
      if (!deniedPath || seen.has(deniedPath)) continue;
      if (!/^(?:\/|[A-Za-z]:\\|\\\\)/.test(deniedPath)) continue;
      seen.add(deniedPath);
      out.push({ deniedPath, grantPath: sandboxGrantPath(deniedPath) });
    }
  }
  return out;
}
