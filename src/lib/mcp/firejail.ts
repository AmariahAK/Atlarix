import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import type { UserSettings } from "@/lib/schemas";

const execFileAsync = promisify(execFile);

export type McpSandboxDiagnostics = {
  platform: NodeJS.Platform;
  firejailFound: boolean;
  firejailPath: string | null;
  sandboxWouldBeActive: boolean;
};

let cachedFirejailPath: string | null | undefined;

function basenameMatchesFirejail(command: string): boolean {
  const base = command.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  return base === "firejail" || base === "firejail.exe";
}

async function resolveFirejailPath(
  customPath?: string,
): Promise<string | null> {
  if (process.platform !== "linux") return null;

  if (customPath?.trim()) {
    const p = customPath.trim();
    if (fs.existsSync(p)) return p;
    return null;
  }

  if (cachedFirejailPath !== undefined) {
    return cachedFirejailPath;
  }

  try {
    const { stdout } = await execFileAsync("which", ["firejail"], {
      timeout: 3000,
    });
    const found = stdout.trim().split("\n")[0];
    cachedFirejailPath = found && fs.existsSync(found) ? found : null;
  } catch {
    cachedFirejailPath = null;
  }
  return cachedFirejailPath;
}

export function buildFirejailArgs(settings: UserSettings): string[] {
  const opts = settings.mcpStdioFirejail;
  const args = [
    "--noprofile",
    "--private-tmp",
    "--nonewprivs",
    "--noroot",
    "--caps.drop=all",
    "--rlimit-nproc=64",
    "--read-only=~",
  ];
  if (!opts?.allowNetwork) {
    args.push("--net=none");
  }
  return args;
}

export type StdioSpawnParams = {
  command: string;
  args: string[];
};

/**
 * Wrap stdio MCP spawn in firejail on Linux when enabled and binary is available.
 */
export async function wrapStdioSpawnForFirejail(
  command: string,
  args: string[],
  settings: UserSettings,
): Promise<StdioSpawnParams> {
  if (process.platform !== "linux" || !settings.sandboxMcpStdio) {
    return { command, args };
  }
  if (basenameMatchesFirejail(command)) {
    return { command, args };
  }

  const firejailPath = await resolveFirejailPath(
    settings.mcpStdioFirejail?.customBinaryPath,
  );
  if (!firejailPath) {
    return { command, args };
  }

  const fjArgs = buildFirejailArgs(settings);
  return {
    command: firejailPath,
    args: [...fjArgs, "--", command, ...args],
  };
}

export async function getMcpSandboxDiagnostics(
  settings: UserSettings,
): Promise<McpSandboxDiagnostics> {
  const platform = process.platform;
  const enabled = Boolean(settings.sandboxMcpStdio);
  const firejailPath =
    platform === "linux"
      ? await resolveFirejailPath(settings.mcpStdioFirejail?.customBinaryPath)
      : null;

  return {
    platform,
    firejailFound: Boolean(firejailPath),
    firejailPath,
    sandboxWouldBeActive:
      platform === "linux" && enabled && Boolean(firejailPath),
  };
}
