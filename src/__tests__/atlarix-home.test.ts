/**
 * A scratch profile keeps the person's own files to itself (ai-46, 2026-10-21):
 * the CLI/ACP model choice lived in ~/.atlarix/cli-state.json whatever
 * ATLARIX_USER_DATA_DIR said, so a QA run on a scratch profile used the owner's
 * model (and fell back to paid Core) and could change it. Global permission
 * rules, agent memory, the CLI log and update stamp were in the same place.
 *
 * Only reads here: on the old code these paths ARE the person's real files.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atlarixHomeDir } from "@/paths/atlarix-home";
import { desktopUserDataDir } from "@/cli/desktop-data";
import { readCliState } from "@/cli/agent/models";
import { globalRulesetPath } from "@/lib/tools/permissions/ruleset";
import { memoryDirFor, setAgentMemoryRootOverride } from "@/lib/agent-memory";

const KEYS = ["ATLARIX_USER_DATA_DIR", "ATLARIX_CLI_STATE_FILE", "ATLARIX_HOME_DIR"] as const;
let saved: Record<string, string | undefined>;
let scratch: string;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-home-"));
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("a scratch profile", () => {
  it("reads its own CLI model choice, not the person's", () => {
    process.env.ATLARIX_USER_DATA_DIR = scratch;
    const own = path.join(scratch, "atlarix-home", "cli-state.json");
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, JSON.stringify({ model: { provider: "scratch-provider", name: "scratch-model" } }));
    expect(readCliState().model).toEqual({ provider: "scratch-provider", name: "scratch-model" });
  });

  it("keeps global rules and agent memory inside it too", () => {
    process.env.ATLARIX_USER_DATA_DIR = scratch;
    const home = path.join(scratch, "atlarix-home");
    expect(globalRulesetPath()).toBe(path.join(home, "permissions.json"));
    // vitest.setup.ts points every test's memory at its own folder: lift that here.
    const testRoot = path.resolve(memoryDirFor("/w"), "..", "..", "..");
    setAgentMemoryRootOverride(null);
    try {
      expect(memoryDirFor("/work/app").startsWith(home + path.sep)).toBe(true);
    } finally {
      setAgentMemoryRootOverride(testRoot);
    }
  });
});

describe("a person's own run", () => {
  it("with no profile set, or the CLI on the desktop's folder, stays in ~/.atlarix", () => {
    const real = path.join(os.homedir(), ".atlarix");
    expect(atlarixHomeDir()).toBe(real);
    process.env.ATLARIX_USER_DATA_DIR = desktopUserDataDir();
    expect(atlarixHomeDir()).toBe(real);
    expect(globalRulesetPath()).toBe(path.join(real, "permissions.json"));
  });

  // Every OS's desktop folder, however it is spelt, is the person's own run.
  it.each([
    ["darwin", { ATLARIX_USER_DATA_DIR: "/Users/p/Library/Application Support/Atlarix/" }],
    ["darwin", { ATLARIX_USER_DATA_DIR: "/Users/p/library/application support/atlarix" }],
    ["linux", { ATLARIX_USER_DATA_DIR: "/home/p/.config/Atlarix" }],
    ["linux", { XDG_CONFIG_HOME: "/data/cfg", ATLARIX_USER_DATA_DIR: "/data/cfg/Atlarix" }],
    ["win32", { APPDATA: "C:\\Users\\p\\AppData\\Roaming", ATLARIX_USER_DATA_DIR: "C:\\Users\\p\\AppData\\Roaming\\Atlarix" }],
  ] as const)("the desktop folder on %s means ~/.atlarix (%j)", (platform, env) => {
    const home = platform === "win32" ? "C:\\Users\\p" : platform === "darwin" ? "/Users/p" : "/home/p";
    // The host's own path rules apply (separators, case-folding): each OS checks its own.
    if (platform !== process.platform && platform !== "linux") return;
    expect(atlarixHomeDir(env as NodeJS.ProcessEnv, platform, home)).toBe(path.join(home, ".atlarix"));
  });

  it("ATLARIX_HOME_DIR names the folder outright (`atlarix run`: throwaway database, the person's rules)", () => {
    process.env.ATLARIX_USER_DATA_DIR = scratch;
    process.env.ATLARIX_HOME_DIR = path.join(os.homedir(), ".atlarix");
    expect(atlarixHomeDir()).toBe(path.join(os.homedir(), ".atlarix"));
  });

  it("ATLARIX_CLI_STATE_FILE still names the state file", () => {
    process.env.ATLARIX_USER_DATA_DIR = scratch;
    const file = path.join(scratch, "elsewhere.json");
    fs.writeFileSync(file, JSON.stringify({ model: { provider: "p", name: "n" } }));
    process.env.ATLARIX_CLI_STATE_FILE = file;
    expect(readCliState().model).toEqual({ provider: "p", name: "n" });
  });
});
