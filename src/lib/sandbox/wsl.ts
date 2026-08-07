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
 * CONFINEMENT, v1: `bwrap` inside the distro when it's installed, otherwise
 * unconfined with a warning. The bundled Landlock helper is a Linux ELF that
 * `forge.config.ts` only ships on Linux builds, and cross-building it from
 * `windows-latest` needs a toolchain that runner lacks. Piping it from the
 * `build-linux` job as a CI artifact is tracked in docs/TODO.md.
 */

import { spawnSync } from "node:child_process";
import log from "electron-log";

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

/** Cached per distro: probing costs a subprocess, and this is on the command path. */
const bwrapByDistro = new Map<string, boolean>();

export function resetWslProbeCacheForTests(): void {
  bwrapByDistro.clear();
}

/** Is `bwrap` available inside `distro`? */
function distroHasBwrap(distro: string): boolean {
  const cached = bwrapByDistro.get(distro);
  if (cached !== undefined) return cached;
  let found = false;
  try {
    const probe = spawnSync(
      "wsl.exe",
      ["-d", distro, "--", "sh", "-c", "command -v bwrap >/dev/null 2>&1"],
      { timeout: 15_000, windowsHide: true },
    );
    found = probe.status === 0;
  } catch {
    found = false;
  }
  bwrapByDistro.set(distro, found);
  if (!found) {
    logger.warn(
      `WSL distro "${distro}" has no bwrap; run_command there will be UNCONFINED. ` +
        `Install it in the distro (e.g. apt install bubblewrap) to enable confinement.`,
    );
  }
  return found;
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
  /** True only when bwrap is actually applied inside the distro. */
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

  if (distroHasBwrap(loc.distro)) {
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
    note: `WSL distro "${loc.distro}" has no bwrap installed`,
  };
}
