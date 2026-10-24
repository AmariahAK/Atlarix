/**
 * Test runs never write the app's real log.
 *
 * electron-log names its file after the nearest package.json ("Atlarix"), so a
 * test that logs writes ~/Library/Logs/Atlarix/main.log (Windows:
 * %APPDATA%\Atlarix\logs, Linux: ~/.config/Atlarix/logs), the file the
 * installed app writes. A whole bun run filled it and rotated the app's own
 * history out (2026-10-24: main.log and main.old.log were only test output;
 * once before, 2026-08-05). Every run logs to a folder of its own under the
 * temp dir instead, named in ATLARIX_TEST_LOG_DIR, and a guard test in each
 * runner checks it.
 *
 * Loaded first by the vitest setup files and the bun preload.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import log from "electron-log";

const dir = (process.env.ATLARIX_TEST_LOG_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-test-logs-")));

// A name of its own: without one electron-log throws "can't determine the app
// name" from a test that changed into a temp folder.
log.transports.file.setAppName("Atlarix (tests)");
log.transports.file.resolvePathFn = () => path.join(dir, "main.log");

/**
 * Under bun, an electron-log nobody configured (a copy loaded late by work a
 * finished test file left running, after `--isolate` gave the next file fresh
 * modules) names itself from the nearest package.json: the repo's, "Atlarix",
 * and logs to the app's folder (seen once, 2026-10-24). Before the working
 * directory it looks under `--user-data-dir=`, which nothing here reads: point
 * that at a folder whose package.json says "Atlarix (tests)". (vitest's own
 * entry names it "vitest" already.)
 */
if (typeof Bun !== "undefined" && !process.argv.some((a) => a.startsWith("--user-data-dir="))) {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "atlarix-tests", productName: "Atlarix (tests)", private: true }),
  );
  process.argv.push(`--user-data-dir=${dir}`);
}
