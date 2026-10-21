import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp", isPackaged: false }, ipcMain: { handle: vi.fn() } }));

import { firstOpenThisRun } from "@/ipc/handlers/app_handlers";

/**
 * `get-app` runs whenever the app asks about a workspace (every screen change,
 * every message, during a turn), so workspace_opened fired ~113 times per
 * person a week (PostHog, 2026-10-18). It is reported once per workspace per run.
 */
describe("workspace_opened", () => {
  it("is reported once per workspace per run, however often the app reads it", () => {
    expect(firstOpenThisRun(901)).toBe(true);
    expect(firstOpenThisRun(901)).toBe(false);
    expect(firstOpenThisRun(901)).toBe(false);
    expect(firstOpenThisRun(902)).toBe(true);
  });
});
