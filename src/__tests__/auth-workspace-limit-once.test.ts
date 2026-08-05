/**
 * `auth:enforce-workspace-limit` runs ONCE per signed-in session.
 *
 * `useAuth` is an unshared hook that ~24 files import, each with its own effect, and its
 * OAuth-success handler invokes this channel — so one sign-in fired it repeatedly
 * (observed: five "Enforcing workspace limit" lines per sign-in).
 *
 * That was never merely wasteful. This handler DELETES workspaces (Free tier keeps the
 * oldest), so N concurrent copies each read the workspace list and delete everything after
 * the first row. It got away with it only because better-sqlite3 is synchronous, so the
 * later copies happened to observe the post-delete state and no-op. A destructive
 * operation racing itself is not something to leave standing on that basis.
 *
 * Fixed in the HANDLER, not the hook: guarding 24 call sites means re-deriving the
 * invariant at the 25th. The invariant belongs where the deletion is.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: number; name: string; createdAt: Date };

const { state, isPro } = vi.hoisted(() => ({
  state: { rows: [] as { id: number; name: string; createdAt: Date }[], selects: 0 },
  isPro: vi.fn(() => false),
}));

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
    isPro,
    getEffectiveTier: () => "free",
    canCreateWorkspace: async () => ({ allowed: true, maxAllowed: 1, currentCount: 0 }),
    getCurrentWorkspaceDetails: async () => null,
    signOut: async () => {},
  },
}));

/**
 * A mutable fake `apps` table that counts reads, so "how many times did enforcement run?"
 * is observable rather than inferred from log lines.
 */
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        all: () => {
          state.selects++;
          return [...state.rows];
        },
      }),
    }),
    delete: () => ({
      where: () => ({
        run: () => {
          // Emulate "delete the rows this call targeted": the handler deletes one row per
          // call, so drop the newest each time (it keeps the oldest).
          state.rows = state.rows.slice(0, -1);
        },
      }),
      run: () => {
        state.rows = [];
      },
    }),
  },
}));
vi.mock("@/db/schema", () => ({ apps: {}, chatSessions: {} }));

import { ipcMain } from "electron";
import { registerAuthHandlers } from "@/ipc/handlers/auth_handlers";

type Handler = (event: unknown, payload?: unknown) => Promise<unknown>;

function latestHandler(channel: string): Handler {
  const calls = (ipcMain.handle as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  const found = [...calls].reverse().find((c) => c[0] === channel);
  if (!found) throw new Error(`no handler registered for ${channel}`);
  return found[1] as Handler;
}

const row = (id: number, ageDays: number): Row => ({
  id,
  name: `ws-${id}`,
  createdAt: new Date(2026, 0, 1 + ageDays),
});

beforeEach(async () => {
  isPro.mockReturnValue(false);
  (ipcMain.handle as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
  registerAuthHandlers();
  await latestHandler("auth:sign-out")({}); // start from a signed-out state
  state.rows = [row(1, 0), row(2, 1), row(3, 2)];
  state.selects = 0;
});

describe("auth:enforce-workspace-limit", () => {
  it("runs ONCE for a burst of concurrent consumers", async () => {
    const handler = latestHandler("auth:enforce-workspace-limit");
    const results = (await Promise.all([
      handler({}),
      handler({}),
      handler({}),
      handler({}),
      handler({}),
    ])) as { removed: number }[];

    // One read of the workspace table across five callers.
    expect(state.selects).toBe(1);
    // Every caller gets the real answer, not a placeholder.
    for (const r of results) expect(r.removed).toBe(2);
    expect(state.rows.map((r) => r.id)).toEqual([1]); // oldest kept
  });

  it("does not re-run for a later call in the same session", async () => {
    const handler = latestHandler("auth:enforce-workspace-limit");
    await handler({});
    expect(state.selects).toBe(1);

    // A consumer mounting later in the session must not trigger another deletion pass.
    state.rows = [row(1, 0), row(9, 5)];
    await handler({});
    expect(state.selects).toBe(1);
    expect(state.rows.map((r) => r.id)).toEqual([1, 9]); // untouched
  });

  it("enforces again after sign-out, for the next account", async () => {
    const handler = latestHandler("auth:enforce-workspace-limit");
    await handler({});
    expect(state.selects).toBe(1);

    await latestHandler("auth:sign-out")({});
    state.rows = [row(4, 0), row(5, 1)];
    state.selects = 0;

    const result = (await handler({})) as { removed: number };
    expect(state.selects).toBe(1);
    expect(result.removed).toBe(1);
  });

  it("is a no-op for Pro, and that answer is remembered too", async () => {
    isPro.mockReturnValue(true);
    const handler = latestHandler("auth:enforce-workspace-limit");
    const result = (await handler({})) as { removed: number };
    expect(result.removed).toBe(0);
    expect(state.selects).toBe(0); // never even read the table
    expect(state.rows).toHaveLength(3); // nothing deleted
  });

  it("does NOT remember a FAILED enforcement — it stays retryable", async () => {
    isPro.mockImplementationOnce(() => {
      throw new Error("subscription lookup exploded");
    });
    const handler = latestHandler("auth:enforce-workspace-limit");
    const failed = (await handler({})) as { success: boolean };
    expect(failed.success).toBe(false);

    // The next call must actually try again rather than replay the failure.
    const retried = (await handler({})) as { success: boolean; removed: number };
    expect(retried.success).toBe(true);
    expect(retried.removed).toBe(2);
  });
});
