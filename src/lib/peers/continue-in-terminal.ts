/**
 * App → CLI handoff: open the user's terminal in the session's folder, running
 * `atlarix --resume <session>`. The CLI and the app share one database, so the
 * session (messages, plan, mode) is simply there when the CLI opens it.
 */
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where `atlarix` lives: the login shell's PATH first, then the installers' usual places. */
export async function findAtlarixCli(): Promise<string | null> {
  const pinned = process.env.ATLARIX_CLI_PATH;
  if (pinned && fs.existsSync(pinned)) return pinned;
  if (process.platform !== "win32") {
    const shell = process.env.SHELL || "/bin/zsh";
    const fromShell = await new Promise<string | null>((resolve) => {
      execFile(
        shell,
        ["-lc", "command -v atlarix"],
        { timeout: 5_000 },
        (err, out) =>
          resolve(err ? null : out.trim().split("\n").pop() || null),
      );
    });
    if (fromShell && fs.existsSync(fromShell)) return fromShell;
  }
  const home = os.homedir();
  const candidates =
    process.platform === "win32"
      ? [path.join(home, ".atlarix", "bin", "atlarix.exe")]
      : [
          path.join(home, ".atlarix", "bin", "atlarix"),
          path.join(home, ".local", "bin", "atlarix"),
          "/opt/homebrew/bin/atlarix",
          "/usr/local/bin/atlarix",
        ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/** Single-quote for a POSIX shell. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Exported for tests: what each platform runs. */
export function terminalCommand(
  platform: NodeJS.Platform,
  cli: string,
  dir: string,
  sessionId: string,
  dataDir?: string,
): { file: string; args: string[] } | null {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  // An app running on a non-default data folder hands its CLI the same one, or
  // the CLI would open the user's usual data and not find the session.
  const env = dataDir ? `ATLARIX_USER_DATA_DIR=${q(dataDir)} ` : "";
  if (platform === "darwin") {
    const line = `cd ${q(dir)} && ${env}${q(cli)} --resume ${sessionId}`;
    // AppleScript string literal: escape backslashes and quotes.
    const literal = line.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return {
      file: "osascript",
      args: [
        "-e",
        'tell application "Terminal" to activate',
        "-e",
        `tell application "Terminal" to do script "${literal}"`,
      ],
    };
  }
  if (platform === "win32") {
    return {
      file: "cmd.exe",
      args: [
        "/c",
        "start",
        "",
        "cmd",
        "/k",
        `cd /d "${dir}" && ${dataDir ? `set "ATLARIX_USER_DATA_DIR=${dataDir}" && ` : ""}"${cli}" --resume ${sessionId}`,
      ],
    };
  }
  return {
    file: "x-terminal-emulator",
    args: [
      "-e",
      "sh",
      "-c",
      `cd ${q(dir)} && ${env}${q(cli)} --resume ${sessionId}; exec "$SHELL"`,
    ],
  };
}

export async function continueInTerminal(
  sessionId: string,
  dir: string,
): Promise<{ ok: boolean; error?: string }> {
  const cli = await findAtlarixCli();
  if (!cli) {
    return {
      ok: false,
      error:
        "The Atlarix CLI isn't installed. Install it with `npm i -g atlarix` (or see atlarix.dev/cli), then try again.",
    };
  }
  const cmd = terminalCommand(
    process.platform,
    cli,
    dir || os.homedir(),
    sessionId,
    process.env.ATLARIX_USER_DATA_DIR,
  );
  if (!cmd) return { ok: false, error: "That session id looks wrong." };
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd.file, cmd.args, {
        detached: true,
        stdio: "ignore",
      });
      child.once("error", (e) =>
        resolve({ ok: false, error: `Couldn't open a terminal: ${e.message}` }),
      );
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true });
      });
    } catch (e) {
      resolve({
        ok: false,
        error: `Couldn't open a terminal: ${(e as Error).message}`,
      });
    }
  });
}
