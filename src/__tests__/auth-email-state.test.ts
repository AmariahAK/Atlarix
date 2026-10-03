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

const { openExternal, setSession } = vi.hoisted(() => ({
  openExternal: vi.fn(async (_url: string) => {}),
  setSession: vi.fn(async () => ({
    data: { session: { access_token: "a" }, user: { id: "u", email: "u@example.test" } },
    error: null,
  })),
}));

vi.mock("electron", () => ({
  shell: { openExternal },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
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

  it("leaves OAuth stateless, even after an abandoned email sign-in", async () => {
    await startEmailSignIn();
    await signInWithOAuth("github");
    const r = await handleAuthCallback(callback(""));
    expect(r.error).toBeNull();
    expect(setSession).toHaveBeenCalledOnce();
  });
});
