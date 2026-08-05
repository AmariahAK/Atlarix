/**
 * Signing out clears credentials. It does not delete your work.
 *
 * Until v14.27.0 `auth:sign-out` ran `db.delete(apps).run()` unconditionally,
 * with the comment "fresh start". An `apps` row cascades to chat sessions, MCP
 * servers, daily logs, workflow templates, pivot containers/beacons and
 * automations — so one click on Sign Out erased every trace of every project.
 * The folders on disk survived; everything Atlarix knew about them did not.
 *
 * No comparable tool behaves this way: Claude Code clears tokens on sign-out and
 * its per-project state under `~/.claude/projects/` survives. The deletion is
 * still available, but only when explicitly asked for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let deletedTables: string[] = [];
let signedOutOfSupabase = 0;

vi.mock("@/lib/auth/supabase-client", () => ({
  getSupabaseClient: () => ({ rpc: vi.fn() }),
  getSubscriptionDetails: vi.fn(async () => ({ status: "active", endsAt: null })),
  getOnboardingCompleted: () => true,
  setOnboardingCompleted: () => {},
}));

vi.mock("@/lib/SubscriptionManager", () => ({
  SubscriptionManager: {
    getCurrentUser: () => ({ email: "owner@example.com", id: "u1" }),
    isLoggedIn: () => true,
    isPro: () => false,
    getEffectiveTier: () => "free",
    canCreateWorkspace: async () => ({ allowed: true, maxAllowed: 1, currentCount: 0 }),
    getCurrentWorkspaceDetails: async () => null,
    signOut: async () => {
      signedOutOfSupabase++;
    },
  },
}));

vi.mock("@/db", () => ({
  db: {
    select: () => ({ from: () => ({ all: () => [{ id: 1 }, { id: 2 }] }) }),
    delete: (table: { __name?: string }) => {
      deletedTables.push(table?.__name ?? "apps");
      return { where: () => ({ run: () => {} }), run: () => {} };
    },
  },
}));
vi.mock("@/db/schema", () => ({
  apps: { __name: "apps" },
  chatSessions: { __name: "chat_sessions", workspaceId: {} },
}));

import { ipcMain } from "electron";
import { registerAuthHandlers } from "@/ipc/handlers/auth_handlers";

function signOutHandler() {
  const calls = (ipcMain.handle as unknown as { mock: { calls: unknown[][] } }).mock
    .calls;
  const found = [...calls].reverse().find((c) => c[0] === "auth:sign-out");
  if (!found) throw new Error("auth:sign-out not registered");
  return found[1] as (e: unknown, p?: unknown) => Promise<unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  deletedTables = [];
  signedOutOfSupabase = 0;
  registerAuthHandlers();
});

describe("auth:sign-out", () => {
  it("deletes NOTHING by default", async () => {
    const r = (await signOutHandler()({})) as { success: boolean };
    expect(r.success).toBe(true);
    expect(deletedTables).toEqual([]);
    // …and it still actually signs you out.
    expect(signedOutOfSupabase).toBe(1);
  });

  it("deletes nothing when the flag is explicitly false", async () => {
    await signOutHandler()({}, { removeLocalData: false });
    expect(deletedTables).toEqual([]);
  });

  it("removes local data ONLY when explicitly asked", async () => {
    await signOutHandler()({}, { removeLocalData: true });
    expect(deletedTables).toContain("apps");
    expect(signedOutOfSupabase).toBe(1);
  });

  it("still signs you out if the local-data deletion fails", async () => {
    // Losing the session because a cleanup threw would be the worst of both.
    const { db } = (await import("@/db")) as unknown as {
      db: { delete: unknown };
    };
    const original = db.delete;
    db.delete = () => {
      throw new Error("db exploded");
    };
    try {
      const r = (await signOutHandler()({}, { removeLocalData: true })) as {
        success: boolean;
      };
      expect(r.success).toBe(true);
      expect(signedOutOfSupabase).toBe(1);
    } finally {
      db.delete = original;
    }
  });

  it("no longer registers the retroactive workspace-limit enforcer", async () => {
    // It deleted every workspace but the OLDEST on sign-in. The cap now gates
    // creation instead (ipc/utils/workspace-quota.ts), so this channel should be
    // gone rather than merely unused.
    const calls = (ipcMain.handle as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    expect(calls.some((c) => c[0] === "auth:enforce-workspace-limit")).toBe(false);
  });
});
