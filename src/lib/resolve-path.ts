import { execSync } from "node:child_process";
import { platform } from "node:os";
import fixPath from "fix-path";
import { readSettings } from "../main/settings";
import { resetEnvCache } from "../ipc/utils/read_env";

function withCustomNodePath(pathValue: string): string {
  const settings = readSettings();
  if (!settings.customNodePath) {
    return pathValue;
  }
  const separator = platform() === "win32" ? ";" : ":";
  return `${settings.customNodePath}${separator}${pathValue}`;
}

export function resolveSystemPath(): void {
  if (platform() === "win32") {
    const newPath = execSync("cmd /c echo %PATH%", {
      encoding: "utf8",
    }).trim();
    process.env.PATH = withCustomNodePath(newPath);
    resetEnvCache();
    return;
  }

  fixPath();
  process.env.PATH = withCustomNodePath(process.env.PATH ?? "");
  resetEnvCache();
}
