/**
 * wrap-command.ts — free, per-OS write-confining sandbox for agent `run_command`.
 *
 * Policy: confine file WRITES to the workspace + temp + common package caches;
 * deny writes elsewhere; reads stay broad; NETWORK STAYS ON (so npm/pip/git work).
 *
 * - macOS:   `sandbox-exec` (Seatbelt) — built-in, free.
 * - Linux:   bundled `atlarix-sandbox-linux` (Landlock) helper; falls back to an
 *            OS-installed `bwrap` (bubblewrap), then unsandboxed.
 * - Windows: bundled `atlarix-sandbox.exe` (Low Integrity Level) helper; falls back
 *            to unsandboxed if it is missing or `--probe` fails on this machine.
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
import { pluginControlDenyPaths, readOnlyDenyPaths } from "./deny-paths";

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
   * SOURCE-PROTECTED mode (Explore / Plan / Review, and every sub-agent command).
   *
   * The workspace is STILL WRITABLE. This used to drop it from the writable set
   * entirely, which enforced "no source edits" by also breaking vitest at
   * startup, `npm install`, every build, every dev server and `git fetch` — all
   * of which the mode prompts promised worked.
   *
   * What it now means is the reference-harness shape: workspace writable, plus a
   * short deny set of execution/identity paths (`deny-paths.ts`). "Don't edit
   * the source" moved one layer up, to the command gate
   * (`classifySegment` → `mutating-commands.ts`), which is where Claude Code,
   * Codex and Cursor all enforce it.
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
  /**
   * Whether the KERNEL is enforcing the source-protection deny set, as opposed
   * to the command gate alone.
   *
   * Callers cannot derive this — it depends on which mechanism was available on
   * this machine (Seatbelt and bwrap can deny; the Landlock helper and Windows
   * Low IL cannot). It is reported rather than assumed, because a
   * write-confining control that degrades silently is the exact failure this
   * file already had once, with AppContainer.
   *
   * False whenever `readOnly` was not requested — there is nothing to enforce.
   */
  denyEnforced: boolean;
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
  // buildx's state dir. Deliberately NOT `DOCKER_CONFIG`: that points at the
  // whole Docker config directory, which holds `config.json` — registry
  // credentials and credential-helper configuration. Granting it would make the
  // sandbox a credential-tamper surface for the sake of a timestamp file. Same
  // sub-path discipline as `.local/share` and `.nuget/packages` below.
  "BUILDX_CONFIG",
] as const;

/**
 * Toolchain cache dirs under `$HOME`, on every platform.
 *
 * Kept on Windows as well as POSIX: the Windows shell is Git bash whenever Git for
 * Windows is installed (`resolveWindowsShell`), so MSYS tools genuinely do read
 * `~/.cache` and `~/.config` there, and cargo, rustup, gradle, maven, bun and
 * GOPATH all default to `%USERPROFILE%\.<name>` on Windows too.
 */
export const HOME_CACHE_DIRS: readonly (readonly string[])[] = [
  [".npm"],
  [".cache"],
  [".config"],
  [".yarn"],
  [".pnpm-store"],
  [".bun"],
  [".deno"],
  [".cargo"],
  [".rustup"],
  [".gradle"],
  [".m2"],
  [".gem"],
  [".nuget", "packages"],
  // Docker Desktop's buildx writes an activity timestamp under
  // `~/.docker/buildx/activity/` on EVERY build and ABORTS the build if it
  // cannot — so without this, `docker build` / `docker compose build` simply does
  // not work under the sandbox. Observed 2026-08-29 as an unattributable
  // "operation not permitted" that cost an agent six turns.
  //
  // The parent `~/.docker` is deliberately NOT granted: `config.json` lives there.
  [".docker", "buildx"],
  [".local", "share"],
  [".local", "state"],
  ["go", "pkg"],
];

/**
 * macOS-only locations. These used to sit in the shared list, so with
 * `createMissingCaches` on (every non-darwin platform) Linux and Windows machines
 * had `~/Library/Caches` and `~/Library/pnpm` created in their home directory —
 * a macOS-shaped path no tool on those platforms ever reads.
 */
export const MACOS_CACHE_DIRS: readonly (readonly string[])[] = [
  ["Library", "Caches"],
  ["Library", "pnpm"], // pnpm's default PNPM_HOME on macOS (the store lives here)
];

/**
 * Windows toolchain caches that do NOT live under `$HOME`, so nothing in
 * HOME_CACHE_DIRS covers them.
 *
 * Omitting these was not cosmetic. Under Low IL an unlabelled directory is simply
 * unwritable, so `npm install` run by the agent could not write its cache — npm on
 * Windows defaults to `%LOCALAPPDATA%\npm-cache`, not `~/.npm`, and sets no
 * `npm_config_cache` to be picked up by the env-var layer above.
 *
 * Read from the environment rather than composed from `os.homedir()`, so a
 * redirected AppData is followed instead of guessed — the same reason the Rust
 * helper resolves LocalLow via `SHGetKnownFolderPath`.
 */
/**
 * buildx's state dir when `DOCKER_CONFIG` is redirected but `BUILDX_CONFIG` is not.
 *
 * Neither layer above covers this case on its own: the env layer only sees
 * `BUILDX_CONFIG` (usually unset), and the curated `$HOME/.docker/buildx` entry is
 * the wrong path once `DOCKER_CONFIG` moves. buildx resolves its own default as
 * `$DOCKER_CONFIG/buildx`, so follow that rather than guessing — the same reason
 * `windowsCacheDirs()` reads `LOCALAPPDATA` instead of composing from `homedir()`.
 *
 * Returns nothing when `DOCKER_CONFIG` is unset, because the curated entry already
 * covers the default and a duplicate would just be de-duped.
 */
export function dockerBuildxDirs(): string[] {
  const cfg = process.env.DOCKER_CONFIG;
  return cfg && cfg.length > 0 ? [path.join(cfg, "buildx")] : [];
}

export function windowsCacheDirs(): string[] {
  const local = process.env.LOCALAPPDATA;
  const roaming = process.env.APPDATA;
  const out: string[] = [];
  if (local) {
    out.push(
      path.join(local, "npm-cache"), // npm
      path.join(local, "pnpm"), // pnpm store + default PNPM_HOME
      path.join(local, "Yarn", "Cache"), // yarn classic
      path.join(local, "go-build"), // GOCACHE default
      path.join(local, "deno"), // DENO_DIR default
    );
  }
  if (roaming) out.push(path.join(roaming, "npm")); // npm global prefix
  return out;
}

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
  // Platform-branched — see the three lists above for why a single list was wrong.
  const grantable = [
    ...HOME_CACHE_DIRS.map((segments) => path.join(home, ...segments)),
    ...(process.platform === "darwin"
      ? MACOS_CACHE_DIRS.map((segments) => path.join(home, ...segments))
      : []),
    ...(process.platform === "win32" ? windowsCacheDirs() : []),
    ...dockerBuildxDirs(),
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

function buildSeatbeltProfile(writable: string[], deny: string[] = []): string {
  // Last matching rule wins in SBPL: allow-all, then deny writes, then re-allow
  // writes to the confined set. Network is left allowed by `(allow default)`.
  const allows = writable
    .map((p) => `  (subpath ${JSON.stringify(p)})`)
    .join("\n");
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    allows,
    `  (subpath "/dev")`, // /dev/null, /dev/tty, etc.
    ")",
  ];
  // THE DENY BLOCK MUST COME LAST. SBPL is last-match-wins, so this is what
  // carves the execution/identity paths back out of the workspace grant above;
  // emitted before it, the `(allow file-write* (subpath <workspace>))` would
  // simply win and the protection would be silently absent.
  //
  // `literal` for the single file, `subpath` for the directories. Seatbelt
  // accepts a path that does not exist yet, which is what lets the deny stop
  // `.atlarix/` being CREATED rather than only stopping it being edited.
  if (deny.length > 0) {
    lines.push(
      "(deny file-write*",
      ...deny.map((p) =>
        p.endsWith("config")
          ? `  (literal ${JSON.stringify(p)})`
          : `  (subpath ${JSON.stringify(p)})`,
      ),
      ")",
    );
  }
  return lines.join("\n");
}

function wrapMacos(
  req: SandboxRequest,
  writable: string[],
  deny: string[],
): WrappedSpawn | null {
  if (!existsSync(SANDBOX_EXEC)) {
    return null;
  }
  const profile = buildSeatbeltProfile(writable, deny);
  return {
    file: SANDBOX_EXEC,
    args: ["-p", profile, req.shell, "-c", req.command],
    sandboxed: true,
    useShellOption: false,
    denyEnforced: deny.length > 0,
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
 *
 * NO DEV BRANCH, AND THAT IS THE POINT WORTH KNOWING. This and `findWindowsHelper`
 * check an env override then `process.resourcesPath`, and stop. Under
 * `electron-forge start` there is no `resourcesPath` entry, so neither resolves and
 * the sandbox SILENTLY FALLS BACK — commands in a dev run are less confined than in
 * a packaged one. That is deliberate for a security control (it degrades safely and
 * loudly enough in CI, where the packaged path is what ships), but it means a dev
 * session is not a valid place to test sandbox confinement. Set
 * ATLARIX_SANDBOX_HELPER_LINUX / ATLARIX_SANDBOX_HELPER_WINDOWS to a built binary,
 * or verify in the packaged app.
 *
 * The contrasting pattern, for a FEATURE rather than a control, is
 * `resolveSnapshotPath()` in `src/lib/models_dev.ts`: env → packaged → dev → cwd.
 * Note its own scar tissue — the cwd fallback silently disabled the offline model
 * catalog in headless runs, because cwd there is the benchmark task directory.
 */
export function findLinuxHelper(): string | null {
  const fromEnv = process.env.ATLARIX_SANDBOX_HELPER_LINUX;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const resourcesPath = (
      process as NodeJS.Process & { resourcesPath?: string }
    ).resourcesPath;
    if (resourcesPath) {
      const candidate = path.join(resourcesPath, "atlarix-sandbox-linux");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function wrapLinux(
  req: SandboxRequest,
  writable: string[],
  deny: string[],
): WrappedSpawn | null {
  // Prefer the bundled Landlock helper (self-contained); same CLI contract as the
  // Windows helper: --workspace <dir> [--writable <dir>]... -- <cmd>.
  const helper = findLinuxHelper();
  if (helper) {
    const args = ["--workspace", req.workspacePath];
    for (const p of writable) args.push("--writable", p);
    // Pass the RESOLVED shell. The helper used to hardcode `/bin/sh`, so a command
    // using bashisms worked unsandboxed and failed sandboxed — the sandbox was
    // changing language semantics, not just permissions.
    args.push("--shell", req.shell);
    args.push("--", req.command);
    // NO `--read-only`, and no deny set: LANDLOCK HAS NO DENY PRIMITIVE.
    //
    // `path_beneath_rules` grants write beneath a root; there is no way to punch
    // a hole in one. The obvious workaround — grant every child of the workspace
    // EXCEPT `.git` and `.atlarix` — does not work, and nobody should try it: it
    // leaves the workspace root itself ungranted, so `mkdir node_modules`,
    // `touch newfile` and vitest's own `.vite-temp` creation all fail on a fresh
    // tree. That is precisely the bug this change exists to fix.
    //
    // `--read-only` is also gone: it used to mean "drop the workspace", which is
    // what broke builds and tests. Source protection here is the command gate's
    // `protected-path` rule, and `denyEnforced: false` says so out loud.
    return {
      file: helper,
      args,
      sandboxed: true,
      useShellOption: false,
      denyEnforced: false,
    };
  }
  // Fallback: OS-installed bubblewrap.
  const bwrap = findBwrap();
  if (!bwrap) return null;

  // Read-only root, writable temp + the confined set. Network is NOT unshared, so
  // it stays available. `--bind-try` skips paths that don't exist.
  const args: string[] = [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--die-with-parent",
  ];
  for (const p of writable) {
    args.push("--bind-try", p, p);
  }
  // Re-bind the protected paths READ-ONLY, over the writable bind above.
  //
  // Mount order is last-wins in bwrap, so this must come AFTER the loop or the
  // workspace bind shadows it back to writable. `-try` because a project need
  // not have a `.atlarix/` yet — but note that unlike Seatbelt, a missing path
  // therefore stays unprotected here, so the gate's `protected-path` rule is
  // what stops it being created. That is the one gap between the two kernel
  // mechanisms, and it is why `denyEnforced` is not the whole story anywhere.
  for (const p of deny) {
    args.push("--ro-bind-try", p, p);
  }
  args.push(req.shell, "-c", req.command);
  return {
    file: bwrap,
    args,
    sandboxed: true,
    useShellOption: false,
    denyEnforced: deny.length > 0,
  };
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
    const resourcesPath = (
      process as NodeJS.Process & { resourcesPath?: string }
    ).resourcesPath;
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
    const probe = spawnSync(helper, ["--probe"], {
      timeout: 15_000,
      windowsHide: true,
    });
    windowsHelperUsable = probe.status === 0;
    if (!windowsHelperUsable) {
      logger.warn(
        `Windows sandbox self-probe FAILED (status=${probe.status}); run_command will be ` +
          `unconfined on this machine. ${(probe.stderr?.toString() ?? "").trim().slice(0, 300)}`,
      );
    }
  } catch (e) {
    windowsHelperUsable = false;
    logger.warn(
      `Windows sandbox self-probe could not run: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return windowsHelperUsable;
}

function wrapWindows(
  req: SandboxRequest,
  writable: string[],
): WrappedSpawn | null {
  const helper = findWindowsHelper();
  if (!helper) return null;
  if (!windowsSandboxUsable(helper)) return null;
  const args = ["--workspace", req.workspacePath];
  for (const p of writable) args.push("--writable", p);
  // NO `--read-only`, and no deny set: a Low mandatory label INHERITS downward.
  //
  // The helper grants writes by stamping `S:(ML;OICI;NW;;;LW)` on each writable
  // root, so everything under the workspace — including `.git/` — inherits it.
  // Carving a hole means writing a HIGHER label on those paths and protecting the
  // SACL from inheritance, which leaves persistent ACL changes inside the user's
  // real repository. That is a native-helper change with a permanent side effect
  // on the user's disk, and it is deliberately not taken here.
  //
  // `--read-only` is gone for the same reason it is gone on Linux: it meant
  // "don't stamp the workspace", which is what broke builds, installs and tests.
  // Source protection on Windows is the command gate's `protected-path` rule.
  // Same shell the unsandboxed path uses. On Windows `getAcceptableShell()` prefers
  // Git bash when it's installed, while the helper used to hardcode `cmd.exe /c` —
  // so POSIX-shaped commands failed under the sandbox with cmd syntax errors that
  // looked like sandbox denials but weren't.
  args.push("--shell", req.shell);
  args.push("--", req.command);
  return {
    file: helper,
    args,
    sandboxed: true,
    useShellOption: false,
    denyEnforced: false,
  };
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
  // THE WORKSPACE IS WRITABLE IN BOTH PROFILES NOW.
  //
  // `readOnly` used to pass "" here, dropping the workspace AND every granted
  // extra path from the candidate set. Measured on a real project, that meant
  // vitest could not start (`node_modules/.vite-temp`), `npm install` could not
  // write `node_modules`, no build could emit `dist/`, and `git fetch` could not
  // lock a ref — while three mode prompts told the model all four were allowed.
  //
  // What `readOnly` now buys is the deny set below: the execution/identity paths
  // that must not change whatever else does.
  const writable = defaultWritablePaths(
    workspaceReal,
    req.extraWritablePaths,
    createMissingCaches,
  );
  // Plugin files, the plugin record and hooks.json are denied on EVERY run, not
  // only source-protected ones: they decide what runs next (plugins/control-guard.ts).
  const deny = [
    ...(req.readOnly ? readOnlyDenyPaths(workspaceReal) : []),
    ...pluginControlDenyPaths(),
  ];

  let wrapped: WrappedSpawn | null = null;
  let unavailableNote = "";
  switch (process.platform) {
    case "darwin":
      wrapped = wrapMacos(req, writable, deny);
      unavailableNote = "sandbox-exec not found";
      break;
    case "linux":
      wrapped = wrapLinux(req, writable, deny);
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
          logger.info(
            `Sandboxing run_command via WSL (bwrap) for ${req.workspacePath}`,
          );
          return {
            file: viaWsl.file,
            args: viaWsl.args,
            sandboxed: true,
            useShellOption: false,
            // The WSL route builds its own bwrap invocation in wsl.ts and does
            // not carry the deny set through, so claim nothing for it.
            denyEnforced: false,
          };
        }
        // Routed into the distro but unconfined: still the right OS to run in, so
        // report it as unsandboxed and let the caller's enforce/warn path decide.
        return {
          file: viaWsl.file,
          args: viaWsl.args,
          sandboxed: false,
          useShellOption: false,
          note: viaWsl.note,
          denyEnforced: false,
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
    //
    // The deny status is reported for the same reason, and it is the part a
    // reader is most likely to assume rather than check: on Windows and on the
    // bundled Linux helper the protected paths are enforced ONLY by the command
    // gate, because neither mechanism has a deny primitive.
    const denyStatus = !req.readOnly
      ? "not requested"
      : wrapped.denyEnforced
        ? `kernel-enforced (${deny.length} paths)`
        : "GATE ONLY — no kernel deny primitive on this mechanism";
    logger.info(
      `Sandboxing run_command (${process.platform}); ${writable.length} writable roots; source-protection deny: ${denyStatus}`,
    );
    // `denyEnforced` reports the SOURCE-PROTECTION set; the plugin-control paths
    // are denied on every run and are not what it describes.
    return { ...wrapped, denyEnforced: !!req.readOnly && wrapped.denyEnforced };
  }

  return {
    file: req.shell,
    args: ["-c", req.command],
    sandboxed: false,
    useShellOption: true,
    note: unavailableNote,
    denyEnforced: false,
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
  if (!parent || parent === deniedPath || isBroadRoot(parent))
    return deniedPath;
  return parent;
}

/**
 * Every phrase below is matched CASE-INSENSITIVELY, and both orderings of
 * path-and-phrase are covered. Neither was true, and it cost a real failure:
 * Docker's buildx denial printed `zsh:1: operation not permitted: /Users/…` and
 * `failed to write /Users/…: operation not permitted`, and both were missed — on a
 * capital `O` and on word order. Nothing downstream fired, so an agent spent six
 * turns diagnosing a boundary nobody told it about (2026-08-29).
 *
 * Widening these does NOT widen what can be granted: `parseSandboxDenialsFromOutput`
 * keeps only absolute paths, and `sandboxGrantPath` refuses to hand back a broad
 * root. A false positive costs an unnecessary grant CARD, which the user declines;
 * a false negative costs the whole feedback path, which is what happened.
 */
const DENIAL_PHRASE = "(?:operation not permitted|permission denied)";

const DENIAL_PATTERNS: RegExp[] = [
  // Node/libuv: `EACCES: permission denied, open '/path'` / `EPERM: …, mkdir 'C:\path'`
  /E(?:PERM|ACCES):[^,\n]*,\s*\w+\s+['"]([^'"\n]+)['"]/gi,
  // GNU coreutils: `cannot create directory ‘/path’: Permission denied` (straight
  // or fancy ‘ ’ quotes — include BOTH U+2018 and U+2019).
  new RegExp(
    `cannot (?:create|touch|remove|open)[^'‘’"\n]*['‘’"]([^'‘’"\n]+)['‘’"]:\\s*${DENIAL_PHRASE}`,
    "gi",
  ),
  // PATH then phrase, anchored on the path so ANYTHING may precede it:
  // `mkdir: /path: Operation not permitted`, and equally
  // `failed to write /path: operation not permitted`. Replaces a pattern that
  // required `: ` immediately before the path, which the second shape does not have.
  // The leading boundary is load-bearing: without it `relative/path: operation not
  // permitted` matched the SUBSTRING `/path` and would have raised a grant card for
  // a directory nobody mentioned. `m` so a path at the start of a line still counts.
  new RegExp(
    `(?:^|[\\s'"(=])((?:\\/|[A-Za-z]:\\\\)[^\\s'"]*?):\\s*${DENIAL_PHRASE}`,
    "gim",
  ),
  // PHRASE then path — zsh's spelling: `zsh:1: operation not permitted: /path`.
  new RegExp(`${DENIAL_PHRASE}:\\s*((?:\\/|[A-Za-z]:\\\\)[^\\s'"]+)`, "gi"),
];

/**
 * Should this finished command go through the denial-escalation path, and may it
 * be re-run afterwards?
 *
 * Pure and exported because it IS the new logic, and it used to live inline in a
 * `.then()` closure where nothing could reach it.
 *
 * Two rules:
 *  - **The exit code is not proof that nothing was denied.** A pipeline reports the
 *    LAST command's status, so `docker build … | tail -40` exits 0 while the build
 *    died on a denied write. Gating on failure alone made the escalation unreachable
 *    exactly when it was needed (observed 2026-08-29).
 *  - **A command that reported success is never re-run.** The grant is persisted and
 *    the model is told; re-running could repeat side effects the command already
 *    applied. A FAILED command carries no such risk, and retrying it is the point.
 */
export function sandboxEscalationDecision(result: {
  success: boolean;
  stdout?: string;
  stderr?: string;
}): { escalate: boolean; allowRetry: boolean } {
  if (!result.success) return { escalate: true, allowRetry: true };
  const denied =
    parseSandboxDenialsFromOutput(
      `${result.stderr ?? ""}\n${result.stdout ?? ""}`,
    ).length > 0;
  return { escalate: denied, allowRetry: false };
}

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
