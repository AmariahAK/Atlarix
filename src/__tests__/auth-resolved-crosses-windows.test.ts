/**
 * `auth:resolved` is the ONE channel that carries current auth state to every
 * window. Two halves, and both were broken in the same way for the same reason.
 *
 * `useAuth` is an UNSHARED hook — each of its ~22 consumers holds its own copy of
 * the account — so a window only knows what it is told. It was told neither:
 *
 *  - SIGN OUT announced nothing at all, so a second window kept rendering a
 *    signed-in user until the app restarted.
 *  - SIGN IN announced only over `oauth-callback-success`, which main sends to
 *    `mainWindow` alone, so a second window stayed signed out.
 *
 * The sign-in half is not merely symmetry. `auth-ipc-bridge` REPLAYS the last
 * `auth:resolved` to every late-mounting consumer, and the renderer now CLEARS on
 * a null user — so a stale cached null would sign out a component that mounted
 * after a successful sign-in. Broadcasting on sign-in is what keeps that cache
 * honest, and therefore what makes the clear safe.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const SIGNED_IN_SESSION = {
  user: {
    id: "u-1",
    email: "signed-in@example.test",
    user_metadata: { full_name: "Signed In" },
  },
};

const { supabaseSignOut, getUserPlan, getEffectiveTier, isUserBanned, handleAuthCallback } =
  vi.hoisted(() => ({
    supabaseSignOut: vi.fn(async () => {}),
    getUserPlan: vi.fn(async () => "pro"),
    getEffectiveTier: vi.fn(async () => "pro"),
    isUserBanned: vi.fn(async () => false),
    handleAuthCallback: vi.fn(),
  }));

vi.mock("@/lib/auth/supabase-client", () => ({
  getSession: vi.fn(async () => null),
  getUserPlan,
  isUserBanned,
  getEffectiveTier,
  invalidatePlanCaches: vi.fn(),
  signInWithOAuth: vi.fn(),
  signOut: supabaseSignOut,
  onAuthStateChange: vi.fn(() => () => {}),
  handleAuthCallback,
}));

vi.mock("@/db", () => ({ db: { select: () => ({ from: () => ({ all: () => [] }) }) } }));
vi.mock("@/db/schema", () => ({ apps: {} }));

// Both broadcasts go through the shared helper, so capturing it captures the
// message every window would receive — and keeps the destroyed-window handling
// where it is already tested (broadcast-all-windows.test.ts).
const broadcast = vi.hoisted(() => vi.fn());
vi.mock("@/ipc/utils/broadcast_all_windows", () => ({
  broadcastToAllWindows: broadcast,
}));

import { SubscriptionManager } from "@/lib/SubscriptionManager";

type Sent = { channel: string; payload: unknown };

function sentSoFar(): Sent[] {
  return broadcast.mock.calls.map(([channel, payload]) => ({ channel, payload }));
}

const resolved = () => sentSoFar().filter((s) => s.channel === "auth:resolved");

beforeEach(() => {
  vi.clearAllMocks();
  broadcast.mockClear();
  getUserPlan.mockResolvedValue("pro");
  getEffectiveTier.mockResolvedValue("pro");
  isUserBanned.mockResolvedValue(false);
  handleAuthCallback.mockResolvedValue({
    session: SIGNED_IN_SESSION,
    user: SIGNED_IN_SESSION.user,
    error: null,
  });
});

describe("auth:resolved reaches every window", () => {
  it("signing out announces `user: null` — THE BUG (it announced nothing)", async () => {
    await SubscriptionManager.signOut();

    // One broadcast, fanned to every window by the helper. Before the fix there
    // was no `auth:resolved` on this path at all.
    expect(resolved()).toHaveLength(1);
    expect(resolved()[0].payload).toMatchObject({ user: null, plan: "free" });
  });

  it("the announcement is made AFTER the session is cleared", async () => {
    // Ordering is the whole correctness of the fix: broadcasting first would send
    // the still-signed-in account and leave every other window exactly as wrong.
    await SubscriptionManager.signOut();

    expect(SubscriptionManager.isLoggedIn()).toBe(false);
    expect(resolved()[0]?.payload).toMatchObject({ user: null });
  });

  it("signing in announces the account, so a stale null can never be replayed", async () => {
    await SubscriptionManager.handleOAuthCallback("atlarix://auth/callback");

    // The LAST payload is what the bridge caches and replays to late mounts —
    // if it were still a null, a component mounting after sign-in would clear.
    expect(resolved().length).toBeGreaterThanOrEqual(1);
    expect(resolved().at(-1)?.payload).toMatchObject({
      user: { email: "signed-in@example.test", plan: "pro" },
    });
  });
});
