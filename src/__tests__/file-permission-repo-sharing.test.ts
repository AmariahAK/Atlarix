/**
 * 0g: one repo, one approval — a folder approval in one worktree of a repo
 * covers the same relative path in every other worktree of that repo, but never
 * a different repo. The repo identity is the git COMMON directory, and the path
 * is stored relative to the repo root.
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
  listWorkspaceFilePermissions,
  revokeWorkspaceFilePermission,
  toRepoRelativePathForApp,
  upsertWorkspaceFilePermission,
} from "@/lib/file-permissions-store";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

let root: string;
let mainRepo: string;
let worktreeA: string;
let worktreeB: string;
let subdirWorkspace: string; // a SUBFOLDER of worktreeA (exercises repo-relative paths)
let otherRepo: string;
let appA: number;
let appB: number;
let appSub: number;
let appOther: number;

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-0g-"));
  mainRepo = path.join(root, "main");
  initRepo(mainRepo);
  worktreeA = path.join(root, "wt-a");
  worktreeB = path.join(root, "wt-b");
  git(mainRepo, ["worktree", "add", "-b", "wt-a", worktreeA]);
  git(mainRepo, ["worktree", "add", "-b", "wt-b", worktreeB]);
  subdirWorkspace = path.join(worktreeA, "src");
  fs.mkdirSync(subdirWorkspace, { recursive: true });
  otherRepo = path.join(root, "other");
  initRepo(otherRepo);
});

afterAll(() => {
  try {
    // Remove worktrees so the temp dir can be deleted cleanly.
    git(mainRepo, ["worktree", "remove", "--force", worktreeA]);
    git(mainRepo, ["worktree", "remove", "--force", worktreeB]);
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
  appA = Number(ins.run("wt-a", worktreeA).lastInsertRowid);
  appB = Number(ins.run("wt-b", worktreeB).lastInsertRowid);
  appSub = Number(ins.run("wt-a/src", subdirWorkspace).lastInsertRowid);
  appOther = Number(ins.run("other", otherRepo).lastInsertRowid);
});

describe("one repo, one approval (0g)", () => {
  it("a folder approval in worktree A covers the same relative path in worktree B", () => {
    upsertWorkspaceFilePermission(appA, "directory", "src/cli", "always_allow");
    expect(
      listWorkspaceFilePermissions(appB).map((r) => [
        r.scopeType,
        r.scopeValue,
        r.decision,
      ]),
    ).toContainEqual(["directory", "src/cli", "always_allow"]);
  });

  it("does NOT cover the same path in a different repo", () => {
    upsertWorkspaceFilePermission(appA, "directory", "src/cli", "always_allow");
    expect(listWorkspaceFilePermissions(appOther)).toEqual([]);
  });

  it("revokes from either worktree of the same repo", () => {
    upsertWorkspaceFilePermission(appA, "directory", "src/cli", "always_allow");
    expect(revokeWorkspaceFilePermission(appB, "directory", "src/cli")).toBe(true);
    expect(listWorkspaceFilePermissions(appA)).toEqual([]);
  });

  it("re-expresses a subfolder workspace's path relative to the repo root", () => {
    // appSub's workspace is <repo>/src, so "cli/tui" (workspace-relative) is
    // "src/cli/tui" relative to the repo root — the coordinate path scopes are
    // stored in so every worktree matches.
    expect(toRepoRelativePathForApp(appSub, "cli/tui")).toBe("src/cli/tui");
    // A workspace at the repo root keeps its path unchanged.
    expect(toRepoRelativePathForApp(appA, "src/cli/tui")).toBe("src/cli/tui");
  });

  it("extension rules stay per-workspace (not shared)", () => {
    upsertWorkspaceFilePermission(appA, "extension", ".ts", "always_allow");
    expect(
      listWorkspaceFilePermissions(appA).map((r) => [r.scopeType, r.scopeValue]),
    ).toContainEqual(["extension", ".ts"]);
    expect(
      listWorkspaceFilePermissions(appB).map((r) => [r.scopeType, r.scopeValue]),
    ).not.toContainEqual(["extension", ".ts"]);
  });
});
