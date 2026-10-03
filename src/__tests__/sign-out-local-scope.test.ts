/**
 * Signing out of the desktop app ends the app's session only.
 *
 * supabase-js defaults `signOut()` to scope "global", which revokes EVERY
 * session the account holds: signing out of the app also signed the person out
 * of the Chrome extension, and would sign them out of the CLI, which keeps its
 * own session for the same account.
 */
import { describe, expect, it, vi } from "vitest";

const signOut = vi.fn(async (_opts?: { scope?: string }) => ({ error: null }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { signOut, onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) } }),
}));
vi.mock("@/lib/auth/supabase-secure-storage", () => ({
  createSecureSupabaseStorage: () => ({ getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }),
  clearSupabaseSecureStorage: async () => {},
}));

describe("desktop sign-out", () => {
  it("uses scope 'local'", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY = "sb_publishable_test";
    const mod = await import("@/lib/auth/supabase-client");
    await mod.signOut();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut.mock.calls[0]?.[0]).toEqual({ scope: "local" });
  });
});
