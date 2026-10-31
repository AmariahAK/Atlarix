/**
 * 0o: a folder granted "from now on" must cover a file directly inside it, and
 * a file granted "from now on" must cover that same file on the next edit.
 *
 * Root cause: `edit_file`'s preview path is whatever the model passed — ABSOLUTE
 * when it edited a path read_file echoed back, RELATIVE otherwise. In a NON-git
 * workspace (`~/Documents/Github/AI`), `toRepoRelativePathForApp` returned that
 * path verbatim, so a folder granted from an absolute path never matched a later
 * relative ask (and vice versa). The store must express every path in ONE
 * coordinate (workspace-relative; repo-relative in a git checkout) whatever the
 * model passed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { BUNDLED_MIGRATIONS } from "@/db/migrations/bundled.generated";
import { resetFileRepoContextCacheForTests } from "@/lib/file-permission-repo";

let sqlite: Database.Database;
let dbh: ReturnType<typeof drizzle> & { $client: Database.Database };
vi.mock("@/db", () => ({
  get db() {
    return dbh;
  },
  getDb: () => dbh,
}));

import {
  toRepoRelativePathForApp,
  upsertWorkspaceFilePermission,
} from "@/lib/file-permissions-store";
import { getParentDirectory } from "@/lib/file-permission-scope";
import { runFilePermissionPreflight } from "@/ipc/handlers/file_permission_handlers";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

let root: string;
let worktree: string;
let plainWorkspace: string; // NOT a git repo — the CLI's ~/Documents/Github/AI shape
let appRepo: number;
let appPlain: number;

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "keep.txt"), "x");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "init"]);
}

function freshDb(): void {
  sqlite = new Database(":memory:");
  for (const m of BUNDLED_MIGRATIONS) {
    for (const stmt of m.sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean))
      sqlite.exec(stmt);
  }
  dbh = drizzle(sqlite, { schema }) as typeof dbh;
  dbh.$client = sqlite;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-0o-"));
  const main = path.join(root, "main");
  initRepo(main);
  worktree = path.join(root, "wt");
  git(main, ["worktree", "add", "-b", "wt", worktree]);
  plainWorkspace = path.join(root, "plain");
  fs.mkdirSync(plainWorkspace, { recursive: true });
});

afterAll(() => {
  try {
    git(path.join(root, "main"), ["worktree", "remove", "--force", worktree]);
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* OS temp sweep removes it */
  }
});

beforeEach(() => {
  resetFileRepoContextCacheForTests();
  freshDb();
  const ins = sqlite.prepare("INSERT INTO apps (name, path) VALUES (?, ?)");
  appRepo = Number(ins.run("wt", worktree).lastInsertRowid);
  appPlain = Number(ins.run("plain", plainWorkspace).lastInsertRowid);
});

/** The write side of executePermissionHandler for a folder "from now on". */
function writeFolder(appId: number, filePath: string, recursive: boolean): void {
  const rel = toRepoRelativePathForApp(appId, filePath);
  const dir = getParentDirectory(rel);
  upsertWorkspaceFilePermission(appId, recursive ? "directory" : "folder", dir, "always_allow");
}
function writeFile(appId: number, filePath: string): void {
  const rel = toRepoRelativePathForApp(appId, filePath);
  upsertWorkspaceFilePermission(appId, "file", rel, "always_allow");
}

// The file, relative to the workspace, and as an ABSOLUTE path (what read_file echoes).
const REL = "Atlarix-compaction/src/ipc/handlers/chat_stream/turn-runner/build-branch.ts";
const absOf = (workspace: string) => path.join(workspace, REL);

describe("a folder granted from an absolute path covers the same file asked relative (0o a)", () => {
  it("in a non-git workspace", () => {
    writeFolder(appPlain, absOf(plainWorkspace), false);
    expect(runFilePermissionPreflight("edit_file", REL, appPlain).type).toBe("auto_allow");
  });
});

describe("a folder granted relative covers the same file asked by absolute path", () => {
  it("in a non-git workspace", () => {
    writeFolder(appPlain, REL, false);
    expect(runFilePermissionPreflight("edit_file", absOf(plainWorkspace), appPlain).type).toBe("auto_allow");
  });
});

describe("a file granted from an absolute path covers the same file asked relative (0o b)", () => {
  it("in a non-git workspace", () => {
    writeFile(appPlain, absOf(plainWorkspace));
    expect(runFilePermissionPreflight("edit_file", REL, appPlain).type).toBe("auto_allow");
  });
});

describe("a file granted relative covers the same file asked by absolute path", () => {
  it("in a non-git workspace", () => {
    writeFile(appPlain, REL);
    expect(runFilePermissionPreflight("edit_file", absOf(plainWorkspace), appPlain).type).toBe("auto_allow");
  });
});

describe("a git-repo workspace already normalises both spellings (0g held)", () => {
  it("folder granted absolute covers the relative ask", () => {
    writeFolder(appRepo, absOf(worktree), true);
    expect(runFilePermissionPreflight("edit_file", REL, appRepo).type).toBe("auto_allow");
  });
});
