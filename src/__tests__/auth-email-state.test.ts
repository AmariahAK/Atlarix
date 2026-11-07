/**
 * Email sign-in round-trips a `state` nonce through atlarix.dev/auth/app, and
 * `handleAuthCallback` must refuse a callback that does not carry it back.
 *
 * Without the check, the C4 flow marker is the only gate: while an email
 * sign-in is pending, ANY `atlarix://auth/callback#access_token=…` link — say,
 * one an attacker mailed with their own tokens — would be accepted and sign the
 * app into the attacker's account. OAuth keeps its stateless path (the reverted
 * PKCE/state attempt is in the TODO), which the last case pins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { openExternal, setSession, showMessageBox } = vi.hoisted(() => ({
  showMessageBox: vi.fn(async (_opts: { message: string }) => ({ response: 1 })),
  openExternal: vi.fn(async (_url: string) => {}),
  setSession: vi.fn(async () => ({
    data: { session: { access_token: "a" }, user: { id: "u", email: "u@example.test" } },
    error: null,
  })),
}));

vi.mock("electron", () => ({
  shell: { openExternal },
  dialog: { showMessageBox },
  clipboard: { writeText: vi.fn() },
}));
vi.mock("electron-log", () => {
  const scoped = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  return { default: { scope: () => scoped } };
});
vi.mock("@/lib/auth/supabase-secure-storage", () => ({
  createSecureSupabaseStorage: () => ({}),
  clearSupabaseSecureStorage: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      setSession,
      signInWithOAuth: vi.fn(async () => ({
        data: { url: "https://auth.example.test/authorize" },
        error: null,
      })),
    },
    // ensureUserExists: any failure there is logged and swallowed.
    from: () => {
      throw new Error("no db in this test");
    },
  }),
}));

import {
  cancelPendingOAuthTimeout,
  cancelSignInFlow,
  handleAuthCallback,
  signInWithOAuth,
  startEmailSignIn,
} from "@/lib/auth/supabase-client";

function stateSentToSite(): string {
  const url = new URL(openExternal.mock.calls.at(-1)![0]);
  expect(url.origin + url.pathname).toBe("https://atlarix.dev/auth/app");
  expect(url.searchParams.get("client")).toBe("desktop");
  return url.searchParams.get("state")!;
}

const callback = (extra: string) =>
  `atlarix://auth/callback#access_token=a&refresh_token=r${extra}`;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.example.test";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY = "anon";
  openExternal.mockClear();
  setSession.mockClear();
});

afterEach(() => cancelPendingOAuthTimeout());

describe("email sign-in state", () => {
  it("sends a nonce that looks like one", async () => {
    await startEmailSignIn();
    expect(stateSentToSite()).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  it("accepts the callback that returns the same state", async () => {
    await startEmailSignIn();
    const state = stateSentToSite();
    const r = await handleAuthCallback(callback(`&state=${state}`));
    expect(r.error).toBeNull();
    expect(setSession).toHaveBeenCalledOnce();
  });

  it("refuses a different state without touching the session", async () => {
    await startEmailSignIn();
    const r = await handleAuthCallback(callback("&state=attacker-chosen-state-value"));
    expect(r.error?.message).toMatch(/doesn't match/);
    expect(setSession).not.toHaveBeenCalled();
  });

  it("refuses a callback with no state while an email sign-in is pending", async () => {
    await startEmailSignIn();
    const r = await handleAuthCallback(callback(""));
    expect(r.error).not.toBeNull();
    expect(setSession).not.toHaveBeenCalled();
  });

  it("is single-use: a replay of the good callback is refused", async () => {
    await startEmailSignIn();
    const good = callback(`&state=${stateSentToSite()}`);
    expect((await handleAuthCallback(good)).error).toBeNull();
    expect((await handleAuthCallback(good)).error).not.toBeNull();
  });

  // W1 (Windows fresh-install QA, 2026-11-07): a new user who creates the
  // account, confirms the email or resets the password inside the email flow
  // easily passes 10 minutes, and the app threw its OWN callback away with
  // "Unexpected sign-in link". The nonce already proves the callback is ours.
  it("accepts a slow email sign-in whose state still matches (W1)", async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    await startEmailSignIn();
    const state = stateSentToSite();
    now.mockReturnValue(t0 + 25 * 60_000);
    const r = await handleAuthCallback(callback(`&state=${state}`));
    now.mockRestore();
    expect(r.error).toBeNull();
    expect(setSession).toHaveBeenCalledOnce();
  });

  it("still bounds the email window: a matching state after an hour is too long", async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    await startEmailSignIn();
    const state = stateSentToSite();
    now.mockReturnValue(t0 + 61 * 60_000);
    const r = await handleAuthCallback(callback(`&state=${state}`));
    now.mockRestore();
    expect(r.error?.message).toMatch(/took too long/);
    expect(setSession).not.toHaveBeenCalled();
  });

  it("says a sign-in took too long instead of calling it unexpected (W1)", async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    await signInWithOAuth("github");
    now.mockReturnValue(t0 + 11 * 60_000);
    const r = await handleAuthCallback(callback(""));
    now.mockRestore();
    expect(r.error?.message).toMatch(/took too long/);
    expect(r.error?.message).not.toMatch(/Unexpected/);
    expect(setSession).not.toHaveBeenCalled();
  });

  it("still refuses a callback when no sign-in was started", async () => {
    // Consume whatever an earlier case left pending.
    await handleAuthCallback(callback(""));
    setSession.mockClear();
    const r = await handleAuthCallback(callback(""));
    expect(r.error?.message).toMatch(/Unexpected sign-in link/);
    expect(setSession).not.toHaveBeenCalled();
  });

  // W5: the watchdog fired at 60 s while its text said 180 s, and blamed the
  // deep-link handler while the user was still typing a password.
  it("waits the full 180 s before asking about an email sign-in (W5)", async () => {
    vi.useFakeTimers();
    try {
      showMessageBox.mockClear();
      await startEmailSignIn();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(showMessageBox).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(showMessageBox).toHaveBeenCalledOnce();
      expect(showMessageBox.mock.calls[0]![0].message).not.toMatch(/deep link/i);
    } finally {
      cancelPendingOAuthTimeout();
      vi.useRealTimers();
    }
  });

  // 15.14.0 security gate: OAuth has no nonce, so Cancel must end the flow, or a
  // mailed callback link stays acceptable while the user thinks they cancelled.
  it("Cancel ends an OAuth sign-in: a later callback is refused", async () => {
    await handleAuthCallback(callback("")); // clear anything an earlier case left
    setSession.mockClear();
    await signInWithOAuth("github");
    cancelSignInFlow();
    const r = await handleAuthCallback(callback(""));
    expect(r.error?.message).toMatch(/Unexpected sign-in link/);
    expect(setSession).not.toHaveBeenCalled();
  });

  it("Cancel keeps an email sign-in finishable, since its callback carries the nonce", async () => {
    await startEmailSignIn();
    const state = stateSentToSite();
    cancelSignInFlow();
    const r = await handleAuthCallback(callback(`&state=${state}`));
    expect(r.error).toBeNull();
    expect(setSession).toHaveBeenCalledOnce();
  });

  it("leaves OAuth stateless, even after an abandoned email sign-in", async () => {
    await startEmailSignIn();
    await signInWithOAuth("github");
    const r = await handleAuthCallback(callback(""));
    expect(r.error).toBeNull();
    expect(setSession).toHaveBeenCalledOnce();
  });
});
