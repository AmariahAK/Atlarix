/**
 * The session rating's cadence and where answers go (owner, 2026-10-22):
 * everyone is asked, after 6 turns, once a session, 3 days apart across every
 * surface; signed in it goes to Supabase as the person's own row, signed out
 * as one PostHog event that names nobody. Never a prompt or code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseFeedbackCommand,
  RATING_AFTER_TURNS,
  RATING_QUIET_MS,
  shouldAskRating,
} from "@/lib/feedback/session-rating";

describe("when the rating is asked", () => {
  const now = 10 * RATING_QUIET_MS;
  it("after 6 completed turns, not before", () => {
    expect(RATING_AFTER_TURNS).toBe(6);
    expect(shouldAskRating({ turns: 5, now, askedThisSession: false })).toBe(false);
    expect(shouldAskRating({ turns: 6, now, askedThisSession: false })).toBe(true);
  });
  it("once per session", () => {
    expect(shouldAskRating({ turns: 9, now, askedThisSession: true })).toBe(false);
  });
  it("not within 3 days of an answer or dismissal anywhere", () => {
    expect(RATING_QUIET_MS).toBe(3 * 24 * 60 * 60 * 1000);
    expect(shouldAskRating({ turns: 6, now, ratedAt: now - RATING_QUIET_MS + 1, askedThisSession: false })).toBe(false);
    expect(shouldAskRating({ turns: 6, now, ratedAt: now - RATING_QUIET_MS, askedThisSession: false })).toBe(true);
  });
  it("ATLARIX_FORCE_RATING asks after the first turn, whatever the quiet period", () => {
    expect(shouldAskRating({ turns: 1, now, ratedAt: now, askedThisSession: false, force: true })).toBe(true);
    expect(shouldAskRating({ turns: 0, now, askedThisSession: false, force: true })).toBe(false);
  });
});

describe("/feedback", () => {
  it("takes an optional rating, then text", () => {
    expect(parseFeedbackCommand("3 great on refactors")).toEqual({ rating: 3, body: "great on refactors" });
    expect(parseFeedbackCommand("1")).toEqual({ rating: 1 });
    expect(parseFeedbackCommand("the diff view is slow")).toEqual({ body: "the diff view is slow" });
    expect(parseFeedbackCommand("12 tabs is too many")).toEqual({ body: "12 tabs is too many" });
    expect(parseFeedbackCommand("  ")).toEqual({});
  });

  it("a number alone that is not 1-3 is a rating gone wrong, not text (QA E3)", () => {
    expect(parseFeedbackCommand("7")).toEqual({ problem: "rating" });
    expect(parseFeedbackCommand(" 0 ")).toEqual({ problem: "rating" });
  });

  it("text over 2,000 characters is refused whole, never cut (QA E3)", () => {
    const long = "x".repeat(2001);
    expect(parseFeedbackCommand(long)).toEqual({ body: long, problem: "too_long" });
    expect(parseFeedbackCommand(`2 ${long}`)).toEqual({ rating: 2, body: long, problem: "too_long" });
    expect(parseFeedbackCommand("x".repeat(2000)).problem).toBeUndefined();
  });
});

// ── where answers go ──────────────────────────────────────────────────────────
const rpc = vi.fn();
let session: unknown = null;
const anon: Array<Record<string, unknown>> = [];
const rated: Array<Record<string, unknown>> = [];
vi.mock("electron", () => ({ app: { getVersion: () => "15.10.1" } }));
vi.mock("@/lib/auth/supabase-client", () => ({
  getSession: async () => session,
  getSupabaseClient: () => ({ rpc }),
}));
vi.mock("@/ipc/shared/language_model_helpers", () => ({
  getLanguageModelProviders: async () => [
    { id: "anthropic", type: "cloud" },
    { id: "custom::my-gateway", type: "custom", apiFormat: "anthropic" },
    { id: "ollama", type: "local" },
  ],
}));
vi.mock("@/main/lib/analytics", () => ({
  captureAnonymousFeedback: (p: Record<string, unknown>) => (anon.push(p), true),
  captureSafe: (_e: string, p: Record<string, unknown>) => void rated.push(p),
  providerFields: (id: string, type?: string, fmt?: string) =>
    type === "custom" ? { provider: "custom", provider_type: `custom:${fmt}` } : { provider: id, provider_type: id },
}));
vi.mock("@/main/settings", () => ({ readSettings: () => ({}), writeSettings: () => {} }));
vi.mock("../main/settings", () => ({ readSettings: () => ({}), writeSettings: () => {} }));

const { sendSessionFeedback } = await import("@/main/lib/session-feedback");

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: { ok: true }, error: null });
  anon.length = 0;
  rated.length = 0;
  session = { user: { id: "u1" } };
});

describe("sending", () => {
  it("signed in: the person's own row, with the session's shape and nothing else", async () => {
    const res = await sendSessionFeedback(
      { kind: "rating", rating: 3 },
      { provider: "custom::my-gateway", model: "glm-4.7", mode: "ask", effort: "high", turns: 7, startedAt: Date.now() - 12 * 60_000 },
    );
    expect(res).toEqual({ ok: true });
    const p = rpc.mock.calls[0]![1].p;
    expect(rpc.mock.calls[0]![0]).toBe("record_session_feedback");
    expect(p).toMatchObject({
      kind: "rating",
      rating: 3,
      app_version: "15.10.1",
      provider: "custom",
      provider_type: "byok",
      model: "glm-4.7",
      mode: "explore",
      effort: "high",
      turns: 7,
      session_minutes: 12,
    });
    // A provider the user named never leaves the machine.
    expect(JSON.stringify(p)).not.toContain("my-gateway");
    expect(anon).toHaveLength(0);
  });

  it("Core and Auto, and a model on this machine", async () => {
    await sendSessionFeedback({ kind: "rating", rating: 2 }, { provider: "compass", model: "core-auto" });
    await sendSessionFeedback({ kind: "rating", rating: 2 }, { provider: "compass", model: "core-2" });
    await sendSessionFeedback({ kind: "rating", rating: 2 }, { provider: "ollama", model: "qwen3" });
    expect(rpc.mock.calls.map((c) => c[1].p.provider_type)).toEqual(["auto", "core", "local"]);
  });

  it("text is capped, and a failed send says so", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "Could not find the function" } });
    const res = await sendSessionFeedback({ kind: "text", body: "x".repeat(5000) }, {});
    expect(res.ok).toBe(false);
    expect(rpc.mock.calls[0]![1].p.body).toHaveLength(2000);
  });

  it("signed out: one PostHog event, no account, at most 5 an hour", async () => {
    session = null;
    for (let i = 0; i < 6; i++) await sendSessionFeedback({ kind: "text", body: `idea ${i}` }, { mode: "build" });
    expect(rpc).not.toHaveBeenCalled();
    expect(anon).toHaveLength(5);
    expect(anon[0]).toMatchObject({ kind: "text", body: "idea 0", mode: "build" });
    expect(anon[0]).not.toHaveProperty("user_id");
  });

  it("a rating also goes to the dashboards when analytics is on (captureSafe checks consent)", async () => {
    await sendSessionFeedback({ kind: "rating", rating: 1 }, {});
    expect(rated[0]).toMatchObject({ rating: "bad" });
    await sendSessionFeedback({ kind: "text", body: "hi" }, {});
    expect(rated).toHaveLength(1);
  });
});
