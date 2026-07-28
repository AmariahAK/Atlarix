/**
 * The workspace path-existence sweep caches the POSITIVE result for the session,
 * so the app list and the window-focus refresh don't each re-stat a workspace
 * that exists — which on macOS re-prompted for folder access on every focus.
 *
 * A `false` is deliberately NOT cached: "missing" is recoverable, and caching it
 * left a workspace stuck on "Folder not found" for the whole session after a
 * delete-and-re-clone, with no way back but restarting the app.
 *
 * Platform-independent: we assert on how often fs.existsSync is called.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  existsSync: vi.fn((_p: string) => true),
  rows: [] as { id: number; path: string }[],
}));

vi.mock("node:fs", () => ({ default: { existsSync: h.existsSync } }));
vi.mock("@/db", () => ({
  db: { select: () => ({ from: async () => h.rows }) },
}));
vi.mock("@/db/schema", () => ({ apps: { id: "id", path: "path" } }));
vi.mock("@/paths/paths", () => ({ getAtlarixAppPath: (p: string) => p }));
vi.mock("@/ipc/utils/broadcast_all_windows", () => ({
  broadcastToAllWindows: vi.fn(),
}));

import {
  computeAllWorkspacePathStatuses,
  workspacePathExists,
  invalidateWorkspacePathStatusCache,
} from "@/ipc/utils/workspace_path_status_broadcast";

describe("workspace path-status session cache", () => {
  beforeEach(() => {
    h.existsSync.mockReset();
    h.existsSync.mockImplementation(() => true);
    invalidateWorkspacePathStatusCache();
  });

  it("stats each workspace path at most once across repeated computes", async () => {
    h.rows = [
      { id: 1, path: "/Users/me/Documents/a" },
      { id: 2, path: "/Users/me/Documents/b" },
    ];
    await computeAllWorkspacePathStatuses(); // initial sweep
    await computeAllWorkspacePathStatuses(); // focus refresh — served from cache
    await computeAllWorkspacePathStatuses();
    expect(h.existsSync).toHaveBeenCalledTimes(2); // once per path, not per call
  });

  it("treats remote workspaces as present without statting", () => {
    expect(workspacePathExists(9, "atlarix-remote://team/x")).toBe(true);
    expect(h.existsSync).not.toHaveBeenCalled();
  });

  it("re-stats after the cache is invalidated", async () => {
    h.rows = [{ id: 1, path: "/Users/me/Documents/a" }];
    await computeAllWorkspacePathStatuses();
    expect(h.existsSync).toHaveBeenCalledTimes(1);
    invalidateWorkspacePathStatusCache();
    await computeAllWorkspacePathStatuses();
    expect(h.existsSync).toHaveBeenCalledTimes(2);
  });

  it("recovers when a missing folder comes back, with no explicit invalidate", async () => {
    // The reported bug: repo deleted → stat'd missing → re-cloned to the same
    // path → the chip still said "Folder not found" until the app restarted,
    // because the negative was cached for the session and nothing in the app
    // ever called invalidateWorkspacePathStatusCache().
    h.rows = [{ id: 1, path: "/Users/me/Documents/caddy" }];

    h.existsSync.mockImplementation(() => false);
    expect(await computeAllWorkspacePathStatuses()).toEqual([
      { id: 1, pathExists: false, status: "missing" },
    ]);

    // Folder is back. No invalidate call — recovery must be automatic.
    h.existsSync.mockImplementation(() => true);
    expect(await computeAllWorkspacePathStatuses()).toEqual([
      { id: 1, pathExists: true, status: "active" },
    ]);
  });

  it("keeps the prompt-spam guarantee: a present path is never re-stat'd", async () => {
    h.rows = [{ id: 1, path: "/Users/me/Documents/a" }];
    await computeAllWorkspacePathStatuses();
    await computeAllWorkspacePathStatuses();
    await computeAllWorkspacePathStatuses();
    // Cached true → one stat, so macOS prompts once at most for this workspace.
    expect(h.existsSync).toHaveBeenCalledTimes(1);
  });

  it("re-stats a MISSING path on each read — the bounded cost of recovery", async () => {
    h.existsSync.mockImplementation(() => false);
    h.rows = [{ id: 1, path: "/Users/me/Documents/gone" }];
    await computeAllWorkspacePathStatuses();
    await computeAllWorkspacePathStatuses();
    // Only workspaces the user already sees as broken pay this.
    expect(h.existsSync).toHaveBeenCalledTimes(2);
  });

  it("maps existence to active/missing status", async () => {
    h.existsSync.mockImplementation((p: string) => p.endsWith("a"));
    h.rows = [
      { id: 1, path: "/x/a" },
      { id: 2, path: "/x/b" },
    ];
    const statuses = await computeAllWorkspacePathStatuses();
    expect(statuses).toEqual([
      { id: 1, pathExists: true, status: "active" },
      { id: 2, pathExists: false, status: "missing" },
    ]);
  });
});
