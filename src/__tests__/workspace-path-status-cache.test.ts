/**
 * The workspace path-existence sweep is cached for the session so the app list
 * and the window-focus refresh don't each re-stat every workspace — which on
 * macOS re-prompted for folder access on every focus. Platform-independent: we
 * just assert fs.existsSync is not called more than once per path.
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
