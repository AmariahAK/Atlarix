/**
 * WSL workspace routing for `run_command`.
 *
 * WHY: when a workspace lives inside a WSL distro, the paths and the toolchain are
 * genuinely Linux. Running its commands on the Windows side is wrong in both
 * directions — the Windows toolchain isn't what built the project, and `\\wsl$\…`
 * access from Windows goes over 9P and is slow. Routing into the distro is the
 * correct answer here, not a compromise, and it lets those users get Linux
 * confinement instead of Windows confinement.
 *
 * SCOPE (deliberate): this triggers ONLY for workspaces under `\\wsl$\…` or
 * `\\wsl.localhost\…`. A normal `C:\…` workspace is untouched and keeps the
 * Low-integrity Windows sandbox — we are not moving Windows-native projects into
 * Linux, which would give the agent a different OS than the file-editing tools use.
 *
 * CONFINEMENT: prefers the bundled Landlock helper (`atlarix-sandbox-linux`, piped
 * from the `build-linux` CI job into the Windows build as a CI artifact and shipped
 * via `forge.config.ts` extraResource). Kernel-level, no install needed in the
 * distro. Falls back to `bwrap` when the helper is absent or the kernel is too old,
 * then unconfined with a warning.
 */

import { spawnSync } from "node:child_process";
import log from "electron-log";
import { findLinuxHelper } from "./wrap-command";

const logger = log.scope("command-sandbox");

export interface WslLocation {
  /** Distro name as WSL knows it, e.g. `Ubuntu-22.04`. */
  distro: string;
  /** Absolute path INSIDE the distro, e.g. `/home/me/proj`. */
  linuxPath: string;
}

/**
 * Parse a `\\wsl$\<distro>\<path>` or `\\wsl.localhost\<distro>\<path>` UNC path.
 * Returns null for anything else (including plain `C:\…`), which is the signal to
 * use the normal Windows sandbox.
 *
 * Pure and total — no filesystem access — so it is unit-testable on any host.
 */
export function parseWslPath(p: string): WslLocation | null {
  if (!p) return null;
  // Accept both slash styles: Node and the shell both hand us either.
  const normalized = p.replace(/\//g, "\\");
  const m = /^\\\\(wsl\$|wsl\.localhost)\\([^\\]+)(\\.*)?$/i.exec(normalized);
  if (!m) return null;

  const distro = m[2];
  const tail = m[3] ?? "\\";
  // `\home\me\proj` → `/home/me/proj`; the share root maps to `/`.
  const linuxPath = tail.replace(/\\/g, "/") || "/";
  return { distro, linuxPath: linuxPath === "" ? "/" : linuxPath };
}

// ---------------------------------------------------------------------------
// Confinement resolution: Landlock helper > bwrap > unconfined
// ---------------------------------------------------------------------------

type Confinement = "landlock" | "bwrap" | "none";
const confinementByDistro = new Map<string, { kind: Confinement; helperPath?: string }>();

export function resetWslProbeCacheForTests(): void {
  confinementByDistro.clear();
}

/** Convert a Windows path to a WSL-accessible `/mnt/c/…` path. */
function windowsToWslPath(windowsPath: string): string {
  return windowsPath
    .replace(/^([A-Za-z]):\\/, (_, d: string) => `/mnt/${d.toLowerCase()}/`)
    .replace(/\\/g, "/");
}

/**
 * Probe the bundled Landlock helper inside `distro`. The helper is a Linux ELF
 * shipped via `process.resourcesPath` on the Windows side; drvfs (`/mnt/c/…`)
 * does not set executable permissions, so we copy it to `/tmp` inside the distro
 * and probe from there. The copy + probe runs once per distro.
 */
function probeLandlock(distro: string, wslHelperPath: string): boolean {
  try {
    const probe = spawnSync(
      "wsl.exe",
      ["-d", distro, "--", "sh", "-c",
       `cp "${wslHelperPath}" /tmp/atlarix-sandbox-linux 2>/dev/null && chmod +x /tmp/atlarix-sandbox-linux && /tmp/atlarix-sandbox-linux --probe`],
      { timeout: 15_000, windowsHide: true },
    );
    return probe.status === 0;
  } catch {
    return false;
  }
}

/** Is `bwrap` available inside `distro`? */
function distroHasBwrap(distro: string): boolean {
  try {
    const probe = spawnSync(
      "wsl.exe",
      ["-d", distro, "--", "sh", "-c", "command -v bwrap >/dev/null 2>&1"],
      { timeout: 15_000, windowsHide: true },
    );
    return probe.status === 0;
  } catch {
    return false;
  }
}

/**
 * Resolve the best available confinement for `distro`:
 * 1. Bundled Landlock helper (kernel-level, no install needed in the distro)
 * 2. OS-installed bwrap (bubblewrap)
 * 3. Unconfined (with a warning)
 */
function resolveConfinement(distro: string): { kind: Confinement; helperPath?: string } {
  const cached = confinementByDistro.get(distro);
  if (cached) return cached;

  // 1. Try the bundled Landlock helper
  const helperWinPath = findLinuxHelper();
  if (helperWinPath) {
    const wslPath = windowsToWslPath(helperWinPath);
    if (probeLandlock(distro, wslPath)) {
      const entry = { kind: "landlock" as const, helperPath: "/tmp/atlarix-sandbox-linux" };
      confinementByDistro.set(distro, entry);
      logger.info(`WSL distro "${distro}": using bundled Landlock helper for confinement.`);
      return entry;
    }
    logger.info(
      `WSL distro "${distro}": Landlock helper present but --probe failed ` +
        `(kernel too old or missing Landlock support); falling back to bwrap.`,
    );
  }

  // 2. Try bwrap
  if (distroHasBwrap(distro)) {
    const entry = { kind: "bwrap" as const };
    confinementByDistro.set(distro, entry);
    return entry;
  }

  // 3. Unconfined
  const entry = { kind: "none" as const };
  confinementByDistro.set(distro, entry);
  logger.warn(
    `WSL distro "${distro}" has no Landlock support and no bwrap; run_command there will be UNCONFINED. ` +
      `Install bwrap in the distro (e.g. apt install bubblewrap) to enable confinement.`,
  );
  return entry;
}

/**
 * bwrap arguments for a WSL run: read-only root, writable temp and the granted set.
 * Network is deliberately NOT unshared. Mirrors the native-Linux bwrap profile in
 * `wrap-command.ts`.
 */
function bwrapArgs(writableLinuxPaths: string[], shell: string, command: string): string[] {
  const args = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--die-with-parent",
  ];
  for (const p of writableLinuxPaths) {
    args.push("--bind-try", p, p);
  }
  args.push(shell, "-c", command);
  return args;
}

export interface WslSpawn {
  file: string;
  args: string[];
  /** True when Landlock or bwrap confinement is applied inside the distro. */
  sandboxed: boolean;
  /** Set when routed but unconfined, so the caller can warn accurately. */
  note?: string;
}

/**
 * Build a spawn that runs `command` inside the WSL distro owning `workspacePath`.
 * Returns null when the workspace is not a WSL path.
 *
 * `extraWritablePaths` are filtered to those that are themselves WSL paths in the
 * SAME distro: the Windows-side cache directories in the default writable set
 * (`%USERPROFILE%\.npm` and friends) do not exist inside the distro, so granting
 * them would be meaningless.
 */
export function wrapWsl(req: {
  workspacePath: string;
  shell: string;
  command: string;
  extraWritablePaths?: string[];
  readOnly?: boolean;
}): WslSpawn | null {
  const loc = parseWslPath(req.workspacePath);
  if (!loc) return null;

  const writable: string[] = [];
  if (!req.readOnly) writable.push(loc.linuxPath);
  for (const extra of req.extraWritablePaths ?? []) {
    const parsed = parseWslPath(extra);
    if (parsed && parsed.distro.toLowerCase() === loc.distro.toLowerCase()) {
      writable.push(parsed.linuxPath);
    }
  }

  // A POSIX shell inside the distro — the Windows-resolved shell path is
  // meaningless there. Honour $SHELL when the caller passed a plain name.
  const shell = req.shell.includes("\\") || req.shell === "" ? "/bin/sh" : req.shell;

  const confinement = resolveConfinement(loc.distro);

  if (confinement.kind === "landlock" && confinement.helperPath) {
    return {
      file: "wsl.exe",
      args: [
        "-d", loc.distro,
        "--cd", loc.linuxPath,
        "--",
        confinement.helperPath,
        "--workspace", loc.linuxPath,
        ...writable.flatMap(p => ["--writable", p]),
        ...(req.readOnly ? ["--read-only"] : []),
        "--shell", shell,
        "--", req.command,
      ],
      sandboxed: true,
    };
  }

  if (confinement.kind === "bwrap") {
    return {
      file: "wsl.exe",
      args: [
        "-d",
        loc.distro,
        "--cd",
        loc.linuxPath,
        "--",
        "bwrap",
        ...bwrapArgs(writable, shell, req.command),
      ],
      sandboxed: true,
    };
  }

  return {
    file: "wsl.exe",
    args: ["-d", loc.distro, "--cd", loc.linuxPath, "--", shell, "-c", req.command],
    sandboxed: false,
    note: `WSL distro "${loc.distro}" has no Landlock support and no bwrap installed`,
  };
}
