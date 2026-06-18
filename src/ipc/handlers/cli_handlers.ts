/**
 * CLI install / uninstall — shell command in PATH (atlarix .)
 */

import { dialog } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLoggedHandler } from "./safe_handle";
import log from "electron-log";
import sudoPrompt from "@vscode/sudo-prompt";
import {
  consumePendingCliWorkspace,
  type CliWorkspacePayload,
} from "../../main/open_workspace_from_cli";

const logger = log.scope("cli-handlers");
const handle = createLoggedHandler(logger);

export type CliInstallResult = {
  success: boolean;
  path?: string;
  message?: string;
  needsSudo?: boolean;
  sudoCommand?: string;
  cancelled?: boolean;
  error?: string;
};

function macLauncherScript(): string {
  return `#!/bin/sh
# Atlarix CLI launcher
ATLARIX_APP="/Applications/Atlarix.app/Contents/MacOS/Atlarix"
if [ ! -f "$ATLARIX_APP" ]; then
  ATLARIX_APP="$HOME/Applications/Atlarix.app/Contents/MacOS/Atlarix"
fi
if [ ! -f "$ATLARIX_APP" ]; then
  echo "atlarix: Atlarix.app not found. Install Atlarix in /Applications." >&2
  exit 1
fi
# Fully detach from the terminal: stdin from /dev/null (so the app never holds
# the controlling TTY — otherwise the shell sees "error on TTY read"), stdout/
# stderr discarded, backgrounded + disowned. Launch the binary directly (not
# 'open -a') so relative paths like '.' resolve against the shell's cwd.
nohup "$ATLARIX_APP" "$@" < /dev/null > /dev/null 2>&1 &
disown $! 2>/dev/null || true
`;
}

function linuxLauncherScript(): string {
  return `#!/bin/sh
# Atlarix CLI launcher
for ATLARIX_BIN in \\
  "/usr/bin/atlarix-app" \\
  "/opt/Atlarix/atlarix" \\
  "$HOME/.local/bin/Atlarix" \\
  "$HOME/Applications/Atlarix.AppImage"; do
  if [ -f "$ATLARIX_BIN" ]; then
    # Detach stdin too (< /dev/null) so the app doesn't hold the controlling TTY.
    nohup "$ATLARIX_BIN" "$@" < /dev/null > /dev/null 2>&1 &
    disown $! 2>/dev/null || true
    exit 0
  fi
done
echo "atlarix: Atlarix binary not found." >&2
exit 1
`;
}

function windowsCmdScript(): string {
  return `@echo off
set ATLARIX_EXE=%LOCALAPPDATA%\\Programs\\atlarix\\Atlarix.exe
if not exist "%ATLARIX_EXE%" (
  set ATLARIX_EXE=%ProgramFiles%\\Atlarix\\Atlarix.exe
)
if not exist "%ATLARIX_EXE%" (
  echo atlarix: Atlarix.exe not found.
  exit /b 1
)
start "" "%ATLARIX_EXE%" %*
`;
}

/** Present only in the TTY-detach-fixed launcher; used to detect a stale install. */
const CLI_LAUNCHER_FIX_MARKER = "< /dev/null";
/** Comment line our generated scripts carry, so self-heal never clobbers a foreign file. */
const CLI_LAUNCHER_SIGNATURE = "Atlarix CLI launcher";

/**
 * Best-effort: if a previously-installed `atlarix` launcher predates the
 * TTY-detach fix, rewrite it in place so the user doesn't have to re-install.
 * Silent + non-elevated — if the file isn't ours or isn't writable (e.g. it was
 * installed with sudo), we skip and leave re-install to Settings. Call at startup.
 */
export function refreshCliLauncherIfStale(): void {
  if (process.platform === "win32") return; // `start` already detaches on Windows
  try {
    const { file } = cliTargetPath();
    if (!fs.existsSync(file)) return;
    const current = fs.readFileSync(file, "utf8");
    if (current.includes(CLI_LAUNCHER_FIX_MARKER)) return; // already fixed
    if (!current.includes(CLI_LAUNCHER_SIGNATURE)) return; // not our script — don't touch
    const content =
      process.platform === "darwin" ? macLauncherScript() : linuxLauncherScript();
    fs.writeFileSync(file, content, { mode: 0o755 });
    logger.info("Refreshed stale atlarix CLI launcher with the TTY-detach fix");
  } catch (err) {
    logger.info(
      "CLI launcher self-heal skipped (re-install from Settings if needed):",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function cliTargetPath(): { dir: string; file: string } {
  if (process.platform === "win32") {
    const dir =
      process.env.LOCALAPPDATA != null
        ? path.join(process.env.LOCALAPPDATA, "Programs", "atlarix")
        : path.join(os.homedir(), "AppData", "Local", "Programs", "atlarix");
    return { dir, file: path.join(dir, "atlarix.cmd") };
  }
  return { dir: "/usr/local/bin", file: "/usr/local/bin/atlarix" };
}

function shellEscapePath(file: string): string {
  return `'${file.replace(/'/g, "'\\''")}'`;
}

function sudoInstallCommand(file: string, content: string): string {
  if (process.platform === "win32") {
    return `Copy atlarix.cmd to a folder on your PATH`;
  }
  return `sudo tee ${shellEscapePath(file)} << 'EOF'\n${content}\nEOF\nsudo chmod +x ${shellEscapePath(file)}`;
}

function isSudoCancelled(err: Error): boolean {
  const msg = err.message?.toLowerCase() ?? "";
  return (
    msg.includes("user did not grant") ||
    msg.includes("cancelled") ||
    msg.includes("canceled") ||
    msg.includes("user canceled")
  );
}

function runSudoCommand(
  command: string,
): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
  if (process.platform === "win32") {
    return Promise.resolve({
      ok: false,
      error: "Windows requires manual PATH setup.",
    });
  }
  return new Promise((resolve) => {
    sudoPrompt.exec(command, { name: "Atlarix" }, (error) => {
      if (error) {
        if (isSudoCancelled(error)) {
          resolve({ ok: false, cancelled: true });
          return;
        }
        resolve({ ok: false, error: error.message });
        return;
      }
      resolve({ ok: true });
    });
  });
}

function runSudoInstall(file: string, content: string): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
  const tmp = path.join(os.tmpdir(), `atlarix-cli-install-${process.pid}`);
  try {
    fs.writeFileSync(tmp, content, { mode: 0o755 });
    const command = `cp ${shellEscapePath(tmp)} ${shellEscapePath(file)} && chmod +x ${shellEscapePath(file)}`;
    return runSudoCommand(command).finally(() => {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* temp cleanup best-effort */
      }
    });
  } catch (err) {
    return Promise.resolve({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function runSudoUninstall(file: string): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
  if (process.platform === "win32") {
    return Promise.resolve({
      ok: false,
      error: "Windows requires manual removal from your PATH folder.",
    });
  }
  return runSudoCommand(`rm -f ${shellEscapePath(file)}`);
}

async function promptSudoInstall(file: string, content: string): Promise<CliInstallResult> {
  const sudoCmd = sudoInstallCommand(file, content);

  const { response } = await dialog.showMessageBox({
    type: "question",
    title: "Install atlarix command",
    message: "Administrator access is required",
    detail:
      "Atlarix can install the CLI command for you, or you can run a command in Terminal.",
    buttons: ["Install with administrator access", "Copy command", "Cancel"],
    defaultId: 0,
    cancelId: 2,
  });

  if (response === 2) {
    logger.info("cli:install cancelled by user");
    return { success: false, cancelled: true };
  }

  if (response === 1) {
    return { success: false, needsSudo: true, sudoCommand: sudoCmd };
  }

  const elevated = await runSudoInstall(file, content);
  if (elevated.ok) {
    return {
      success: true,
      path: file,
      message: "Installed. Open a new terminal and try: atlarix .",
    };
  }
  if (elevated.cancelled) {
    return { success: false, cancelled: true };
  }

  logger.warn("cli:install elevated install failed:", elevated.error);
  await dialog.showMessageBox({
    type: "info",
    title: "Install atlarix command",
    message: "Could not install automatically",
    detail: `Run this in Terminal:\n\n${sudoCmd}`,
    buttons: ["OK"],
  });
  return { success: false, needsSudo: true, sudoCommand: sudoCmd, error: elevated.error };
}

async function promptSudoUninstall(file: string): Promise<CliInstallResult> {
  const sudoCmd =
    process.platform === "win32"
      ? `Remove the file manually:\n${file}`
      : `sudo rm -f ${shellEscapePath(file)}`;

  const { response } = await dialog.showMessageBox({
    type: "question",
    title: "Remove atlarix command",
    message: "Administrator access is required",
    detail:
      "Atlarix can remove the CLI symlink for you, or you can run a command in Terminal.",
    buttons: ["Remove with administrator access", "Copy command", "Cancel"],
    defaultId: 0,
    cancelId: 2,
  });

  if (response === 2) {
    logger.info("cli:uninstall cancelled by user");
    return { success: false, cancelled: true };
  }

  if (response === 1) {
    return { success: false, needsSudo: true, sudoCommand: sudoCmd };
  }

  const elevated = await runSudoUninstall(file);
  if (elevated.ok) {
    return { success: true, message: "Removed atlarix from PATH" };
  }
  if (elevated.cancelled) {
    return { success: false, cancelled: true };
  }

  logger.warn("cli:uninstall elevated remove failed:", elevated.error);
  await dialog.showMessageBox({
    type: "info",
    title: "Remove atlarix command",
    message: "Could not remove automatically",
    detail: `Run this in Terminal:\n\n${sudoCmd}`,
    buttons: ["OK"],
  });
  return { success: false, needsSudo: true, sudoCommand: sudoCmd, error: elevated.error };
}

export function registerCliHandlers(): void {
  handle("cli:install", async (): Promise<CliInstallResult> => {
    const { dir, file } = cliTargetPath();
    const content =
      process.platform === "darwin"
        ? macLauncherScript()
        : process.platform === "win32"
          ? windowsCmdScript()
          : linuxLauncherScript();

    try {
      if (process.platform === "win32") {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(file, content, { mode: 0o755 });
      if (process.platform === "win32") {
        return {
          success: true,
          path: file,
          message: `Installed atlarix.cmd. Add ${dir} to PATH if needed, then run: atlarix .`,
        };
      }
      return {
        success: true,
        path: file,
        message: "Installed. Open a new terminal and try: atlarix .",
      };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EACCES" || code === "EPERM") {
        return promptSudoInstall(file, content);
      }
      logger.warn("cli:install failed:", err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  handle("cli:uninstall", async (): Promise<CliInstallResult> => {
    const { file } = cliTargetPath();
    if (!fs.existsSync(file)) {
      return { success: true, message: "CLI command was not installed" };
    }

    try {
      await fs.promises.unlink(file);
      return { success: true, message: "Removed atlarix from PATH" };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EACCES" || code === "EPERM") {
        return promptSudoUninstall(file);
      }
      logger.warn("cli:uninstall failed:", err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  handle("cli:check-installed", async () => {
    const { file } = cliTargetPath();
    return { installed: fs.existsSync(file), path: file };
  });

  // Renderer pulls (and clears) any CLI workspace buffered before it mounted,
  // so `atlarix .` on a cold start lands in the folder instead of the welcome
  // screen even when the push event raced ahead of the listener.
  handle(
    "workspace:consume-pending-cli",
    async (): Promise<CliWorkspacePayload | null> => consumePendingCliWorkspace(),
  );
}
