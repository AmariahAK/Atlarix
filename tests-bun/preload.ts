// `bun test tests-bun` resolves modules the way the compiled CLI does.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { plugin } from "bun";
// Nothing may log to the app's real log file.
import "../tests/isolate-logs";
import { cliPlugin } from "../scripts/bun-cli-plugin";

/**
 * A profile (database, settings) of its own, never a real one. `npm run
 * test:bun` runs with --isolate, which loads this preload again for each test
 * FILE with the environment as it started, so each file gets a clean one: in
 * one shared database, files saw each other's endpoints and sessions (a test
 * passed alone and failed in the whole run, 2026-10-24). A file that sets its
 * own (`ATLARIX_USER_DATA_DIR = …`) still can.
 */
process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-bun-profile-"));

plugin(cliPlugin(undefined, { runtime: true }));
