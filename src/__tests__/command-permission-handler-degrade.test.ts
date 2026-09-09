/**
 * The `command-permissions:upsert` IPC handler must not throw a raw SqliteError
 * out of IPC when the DB write fails (e.g. disk full) — it returns a clean
 * `{ success: false }` the renderer can surface. Sibling of the execute-permission
 * resilience fix (Sentry 49d4f2a5).
 */
import { describe, expect, it, vi } from "vitest";

// `vi.hoisted` so the spy exists before the hoisted `vi.mock` factory runs.
const { upsertWorkspaceCommandPermission } = vi.hoisted(() => ({
  upsertWorkspaceCommandPermission: vi.fn(() => {
    const e = new Error("unable to open database file") as Error & {
      code: string;
    };
    e.code = "SQLITE_CANTOPEN";
    throw e;
  }),
}));
vi.mock("@/lib/command-permissions-store", () => ({
  getWorkspaceCommandPermission: () => null,
  listWorkspaceCommandPermissions: () => [],
  revokeWorkspaceCommandPermission: () => false,
  upsertWorkspaceCommandPermission,
}));

import { ipcMain } from "electron";
import { registerCommandPermissionHandlers } from "@/ipc/handlers/command_permission_handlers";

type Handler = (event: unknown, payload: unknown) => unknown;

function latestHandler(channel: string): Handler | undefined {
  const calls = (ipcMain.handle as unknown as { mock: { calls: unknown[][] } })
    .mock.calls;
  const found = [...calls].reverse().find((c) => c[0] === channel);
  return found?.[1] as Handler | undefined;
}

describe("command-permissions:upsert graceful degrade on DB failure", () => {
  it("returns { success: false } instead of throwing SqliteError out of IPC", async () => {
    registerCommandPermissionHandlers();
    const handler = latestHandler("command-permissions:upsert");
    expect(handler).toBeTypeOf("function");

    const res = await handler!(
      {},
      { appId: 1, category: "pnpm", decision: "always_allow" },
    );

    expect(res).toMatchObject({ success: false });
    expect(upsertWorkspaceCommandPermission).toHaveBeenCalled();
  });
});
