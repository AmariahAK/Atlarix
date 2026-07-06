import { describe, it, expect, vi } from "vitest";
import { ipcMain } from "electron";
import * as Sentry from "@sentry/electron/main";

/**
 * `list-versions` is polled by the UI. A failing `git log` (unreadable pack,
 * broken repo, …) must degrade to [] with ONE warning per workspace — the old
 * rethrow fed Sentry on every poll.
 */

const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      warn: warnSpy,
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      log: vi.fn(),
    }),
  },
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      apps: {
        findFirst: vi.fn(async () => ({ id: 5, path: "/tmp/fake-app" })),
      },
    },
  },
}));

vi.mock("@/paths/paths", () => ({
  getAtlarixAppPath: (p: string) => p,
}));

vi.mock("@/ipc/utils/git_utils", () => ({
  gitLog: vi.fn(async () => {
    throw new TypeError("Cannot read properties of null (reading 'slice')");
  }),
  findGitRepositoryRoot: vi.fn(() => "/tmp/fake-app"),
  gitCheckout: vi.fn(),
  gitCommit: vi.fn(),
  gitStageToRevert: vi.fn(),
  gitCurrentBranch: vi.fn(),
}));

import { registerVersionHandlers } from "@/ipc/handlers/version_handlers";

function getHandler(channel: string) {
  const call = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([ch]) => ch === channel);
  if (!call) throw new Error(`handler '${channel}' not registered`);
  return call[1] as (event: unknown, args: unknown) => Promise<unknown>;
}

describe("list-versions degradation on git log failure", () => {
  it("returns [] on every poll and warns exactly once per workspace", async () => {
    registerVersionHandlers();
    const listVersions = getHandler("list-versions");

    await expect(listVersions({}, { appId: 5 })).resolves.toEqual([]);
    await expect(listVersions({}, { appId: 5 })).resolves.toEqual([]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("list-versions");
    // The whole point: nothing reaches Sentry anymore.
    expect(vi.mocked(Sentry.captureException)).not.toHaveBeenCalled();
  });
});
