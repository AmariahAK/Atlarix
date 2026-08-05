import { BrowserWindow, clipboard, ipcMain } from "electron";
import { platform, arch } from "os";
import { SystemDebugInfo } from "../ipc_types";
import { readSettings } from "../../main/settings";

import log from "electron-log";
import path from "path";
import fs from "fs";
import { runShellCommandSimple as runShellCommand } from "../utils/runShellCommand";
import { LargeLanguageModel } from "@/lib/schemas";

// Shared function to get system debug info
async function getSystemDebugInfo({
  linesOfLogs,
  level,
}: {
  linesOfLogs: number;
  level: "warn" | "info";
}): Promise<SystemDebugInfo> {
  console.log("Getting system debug info");

  // Get Node.js and pnpm versions
  let nodeVersion: string | null = null;
  let pnpmVersion: string | null = null;
  let nodePath: string | null = null;
  try {
    nodeVersion = await runShellCommand("node --version");
  } catch (err) {
    console.error("Failed to get Node.js version:", err);
  }

  try {
    pnpmVersion = await runShellCommand("pnpm --version");
  } catch (err) {
    console.error("Failed to get pnpm version:", err);
  }

  try {
    if (platform() === "win32") {
      nodePath = await runShellCommand("where.exe node");
    } else {
      nodePath = await runShellCommand("which node");
    }
  } catch (err) {
    console.error("Failed to get node path:", err);
  }

  // Get Atlarix version from package.json
  const packageJsonPath = path.resolve(__dirname, "..", "..", "package.json");
  let atlarixVersion = "unknown";
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    atlarixVersion = packageJson.version;
  } catch (err) {
    console.error("Failed to read package.json:", err);
  }

  // Get telemetry info from settings
  const settings = readSettings();
  const telemetryId = settings.telemetryUserId || "unknown";

  // Get logs from electron-log
  let logs = "";
  try {
    const logPath = log.transports.file.getFile().path;
    if (fs.existsSync(logPath)) {
      const logContent = fs.readFileSync(logPath, "utf8");

      const logLines = logContent.split("\n").filter((line) => {
        if (level === "info") {
          return true;
        }
        // Example line:
        // [2025-06-09 13:55:05.209] [debug] (runShellCommand) Command "which node" succeeded with code 0: /usr/local/bin/node
        const logLevelRegex = /\[.*?\] \[(\w+)\]/;
        const match = line.match(logLevelRegex);
        if (!match) {
          // Include non-matching lines (like stack traces) when filtering for warnings
          return true;
        }
        const logLevel = match[1];
        if (level === "warn") {
          return logLevel === "warn" || logLevel === "error";
        }
        return true;
      });

      logs = logLines.slice(-linesOfLogs).join("\n");
    }
  } catch (err) {
    console.error("Failed to read log file:", err);
    logs = `Error reading logs: ${err}`;
  }

  return {
    nodeVersion,
    pnpmVersion,
    nodePath,
    telemetryId,
    selectedLanguageModel:
      serializeModelForDebug(settings.selectedModel) || "unknown",
    telemetryConsent: settings.telemetryConsent || "unknown",
    telemetryUrl: "https://eu.i.posthog.com", // Matches the live PostHog host in renderer.tsx
    atlarixVersion,
    platform: process.platform,
    architecture: arch(),
    logs,
  };
}

export function registerDebugHandlers() {
  ipcMain.handle(
    "get-system-debug-info",
    async (): Promise<SystemDebugInfo> => {
      console.log("IPC: get-system-debug-info called");
      return getSystemDebugInfo({
        linesOfLogs: 20,
        level: "warn",
      });
    },
  );

  console.log("Registered debug IPC handlers");

  ipcMain.handle("take-screenshot", async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) throw new Error("No focused window to capture");

    // Capture the window's current contents as a NativeImage
    const image = await win.capturePage();
    // Validate image
    if (!image || image.isEmpty()) {
      throw new Error("Failed to capture screenshot");
    }
    // Write the image to the clipboard
    clipboard.writeImage(image);
  });
}

function serializeModelForDebug(model: LargeLanguageModel): string {
  return `${model.provider}:${model.name} | customId: ${model.customModelId}`;
}
