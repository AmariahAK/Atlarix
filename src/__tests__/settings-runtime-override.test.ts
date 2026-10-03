/**
 * The CLI shares the desktop's user-settings.json. Its own choices (deep
 * thinking) are a per-process override: visible to this process's reads, never
 * written to the file, so they cannot flip the desktop app's setting.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSettings, setRuntimeSettingsOverride, writeSettings } from "@/main/settings";

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-override-"));
  process.env.ATLARIX_USER_DATA_DIR = dir;
});
afterAll(() => {
  delete process.env.ATLARIX_USER_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runtime settings override", () => {
  it("is read in this process and never persisted by a later write", () => {
    writeSettings({ deepThinking: false });
    setRuntimeSettingsOverride({ deepThinking: true });
    expect(readSettings().deepThinking).toBe(true);
    // An unrelated write (the CLI saving anything) must not carry it to disk.
    writeSettings({ hasRunBefore: true });
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "user-settings.json"), "utf8"));
    expect(onDisk.deepThinking).toBe(false);
    expect(onDisk.hasRunBefore).toBe(true);
  });
});
