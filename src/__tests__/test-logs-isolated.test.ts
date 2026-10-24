/**
 * A vitest run never writes the app's real log (tests/isolate-logs.ts): a whole
 * test run filled ~/Library/Logs/Atlarix/main.log and rotated the app's own
 * history out, twice.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import log from "electron-log";

/** Where the installed app logs, per electron-log's own rules for each OS. */
function appLogDir(): string {
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Logs", "Atlarix");
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Atlarix", "logs");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Atlarix", "logs");
}

/** Inside the app's log folder ("Atlarix (tests)" beside it is not). */
const inAppLogDir = (p: string) => p === appLogDir() || p.startsWith(appLogDir() + path.sep);

describe("the log file during tests", () => {
  it("is in this run's own folder, never the app's", () => {
    const file = log.transports.file.getFile().path;
    expect(process.env.ATLARIX_TEST_LOG_DIR).toBeTruthy();
    expect(path.dirname(file)).toBe(process.env.ATLARIX_TEST_LOG_DIR);
    expect(inAppLogDir(file)).toBe(false);
  });

  it("gets nothing a test logs", () => {
    const marker = `isolate-logs-marker-${Date.now()}-${Math.random()}`;
    const level = log.transports.file.level;
    log.transports.file.level = "info"; // as a test that turns file logging back on
    try {
      log.info(marker);
    } finally {
      log.transports.file.level = level;
    }
    const real = path.join(appLogDir(), "main.log");
    if (fs.existsSync(real)) expect(fs.readFileSync(real, "utf-8")).not.toContain(marker);
  });
});
