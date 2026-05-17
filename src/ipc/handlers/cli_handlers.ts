/**
 * CLI install / uninstall — shell command in PATH (atlarix .)
 */

import { app, dialog, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLoggedHandler } from "./safe_handle";
import log from "electron-log";

const logger = log.scope("cli-handlers");
const handle = createLoggedHandler(logger);

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
exec "$ATLARIX_APP" "$@"
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
    exec "$ATLARIX_BIN" "$@"
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

export function registerCliHandlers(): void {
  handle("cli:install", async () => {
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
        const cmd =
          process.platform === "win32"
            ? `Copy atlarix.cmd to a folder on your PATH`
            : `sudo tee ${file} << 'EOF'\n${content}\nEOF\nsudo chmod +x ${file}`;
        await dialog.showMessageBox({
          type: "info",
          title: "Install atlarix command",
          message: "Administrator access required",
          detail: `Run this in Terminal:\n\n${cmd}`,
          buttons: ["Copy command", "OK"],
        });
        return { success: false, needsSudo: true, sudoCommand: cmd };
      }
      logger.error("cli:install failed:", err);
      throw err;
    }
  });

  handle("cli:uninstall", async () => {
    const { file } = cliTargetPath();
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return { success: true };
    } catch (err) {
      logger.error("cli:uninstall failed:", err);
      return { success: false, error: String(err) };
    }
  });

  handle("cli:check-installed", async () => {
    const { file } = cliTargetPath();
    return { installed: fs.existsSync(file), path: file };
  });
}
