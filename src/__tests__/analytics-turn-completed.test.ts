/**
 * `turn_completed`: one event per turn with everything about it, and nothing
 * the user typed. Replaces model_turn, core_turn_* and the settings-diff
 * mode/model events. Opted-out users cost nothing: no capture, no lookup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
let consent = "opted_in";
let store: Record<string, unknown> = {};
vi.mock("electron", () => ({ app: { getPath: () => "/tmp/atlarix-analytics-test", getVersion: () => "15.9.9" } }));
vi.mock("posthog-node", () => ({
  PostHog: class {
    capture(e: { event: string; properties: Record<string, unknown> }) {
      captured.push(e);
    }
  },
}));
const settings = () => ({ telemetryConsent: consent, ...store });
const write = (p: Record<string, unknown>) => {
  store = { ...store, ...p };
};
vi.mock("@/main/settings", () => ({ readSettings: settings, writeSettings: write }));
vi.mock("../main/settings", () => ({ readSettings: settings, writeSettings: write }));

process.env.POSTHOG_API_KEY = "phc_test";
const analytics = await import("@/main/lib/analytics");
const { trackTurnCompleted, billingOf } = analytics;
const { noteTurn, noteTurnLoopTotals, noteTurnStreamError, drainTurnStats } = await import("@/lib/analytics/turn-stats");

const flush = () => new Promise((r) => setTimeout(r, 0));
const turns = () => captured.filter((c) => c.event === "turn_completed").map((c) => c.properties);
let nextChat = 1000;
const base = (over: Partial<Parameters<typeof trackTurnCompleted>[0]> = {}) => ({
  chatId: nextChat,
  end: { outcome: "ok" as const },
  mode: "build",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  durationMs: 5_000,
  hadHistory: false,
  outputTokens: 100,
  ...over,
});

beforeEach(() => {
  captured.length = 0;
  consent = "opted_in";
  store = { firstTaskStartedAt: 1, firstTaskCompletedAt: 1 };
  nextChat++;
});

describe("turn_completed", () => {
  it("carries how it ended, the choices and who paid", async () => {
    trackTurnCompleted(base({ effort: "high" }), async () => "cloud");
    await flush();
    expect(turns()).toHaveLength(1);
    expect(turns()[0]).toMatchObject({
      outcome: "ok",
      mode: "build",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      billing: "byok",
      effort: "high",
      origin: "user",
      changed: [],
      duration_bucket: "<10s",
      turn_index_bucket: "1",
      resumed_session: false,
      surface: "app",
    });
    expect(turns()[0]!.$set).toMatchObject({ uses_byok: true, last_billing: "byok" });
  });

  it("billing is the turn's own, even with two chats' turns interleaved", async () => {
    const a = nextChat;
    const b = nextChat + 500;
    trackTurnCompleted(base({ chatId: a, provider: "ollama" }), async () => "local");
    trackTurnCompleted(base({ chatId: b, provider: "compass", model: "core-1" }), async () => undefined);
    await flush();
    const [ta, tb] = turns();
    expect(ta).toMatchObject({ billing: "local", provider: "ollama" });
    expect(tb).toMatchObject({ billing: "core", provider: "compass" });
    // The funnel event takes the turn's billing too (it used to read a global).
    const funnel = captured.filter((c) => c.event === "task_completed").map((c) => c.properties.billing);
    expect(funnel).toEqual(["local", "core"]);
  });

  it("a fallback to Core counts as Core", async () => {
    trackTurnCompleted(base({ fellBackToCore: true }));
    await flush();
    expect(turns()[0]).toMatchObject({ billing: "core", provider: "compass", fell_back_to_core: true });
  });

  it("says what changed since the chat's last turn, and from what", async () => {
    trackTurnCompleted(base());
    trackTurnCompleted(base({ mode: "plan", model: "glm-5", effort: "low" }));
    await flush();
    expect(turns()[1]).toMatchObject({
      changed: ["mode", "model", "effort"],
      prev_mode: "build",
      prev_model: "deepseek-v4-pro",
      turn_index_bucket: "2-5",
    });
  });

  it("a resumed chat's first turn in this process", async () => {
    trackTurnCompleted(base({ hadHistory: true }));
    await flush();
    expect(turns()[0]!.resumed_session).toBe(true);
  });

  it("carries the turn's counters, then forgets them", async () => {
    noteTurn(nextChat, "approvals_asked", 2);
    noteTurn(nextChat, "approvals_auto");
    noteTurn(nextChat, "approvals_denied");
    noteTurn(nextChat, "compactions");
    noteTurn(nextChat, "subagents", 3);
    noteTurn(nextChat, "retries");
    noteTurnLoopTotals(nextChat, { iterations: 4, tool_count: 7 });
    trackTurnCompleted(base());
    await flush();
    expect(turns()[0]).toMatchObject({
      approvals_asked: 2,
      approvals_auto: 1,
      approvals_denied: 1,
      compactions: 1,
      subagents: 3,
      retries: 1,
      iterations: 4,
      tool_count: 7,
    });
    expect(drainTurnStats(nextChat).counts.subagents).toBe(0);
  });

  it("the stream's own error replaces the SDK's stand-in", async () => {
    noteTurnStreamError(nextChat, { kind: "quota", httpStatus: 402 });
    trackTurnCompleted(base({ end: { outcome: "error", errorKind: "no_output" }, outputTokens: 0 }));
    await flush();
    expect(turns()[0]).toMatchObject({ outcome: "error", error_kind: "quota", http_status: 402 });
  });

  it("an error the stream showed, on a turn that then returned nothing, is an error", async () => {
    noteTurnStreamError(nextChat, { kind: "auth", httpStatus: 401 });
    trackTurnCompleted(base({ outputTokens: 0 }));
    await flush();
    expect(turns()[0]).toMatchObject({ outcome: "error", error_kind: "auth" });
    expect(captured.some((c) => c.event === "task_completed")).toBe(false);
  });

  it("a turn that recovered keeps ok and says what it recovered from", async () => {
    noteTurnStreamError(nextChat, { kind: "network" });
    trackTurnCompleted(base());
    await flush();
    expect(turns()[0]).toMatchObject({ outcome: "ok", recovered_error_kind: "network" });
  });

  it("opted out: nothing sent, no provider lookup, and the counters still drain", async () => {
    consent = "opted_out";
    const lookup = vi.fn(async () => "cloud");
    noteTurn(nextChat, "retries");
    trackTurnCompleted(base(), lookup);
    await flush();
    expect(captured).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
    expect(drainTurnStats(nextChat).counts.retries).toBe(0);
  });

  it("never carries prompt text, paths or emails", async () => {
    const { classifyTurnEnd, classifyTurnError } = await import("@/lib/analytics/turn-end");
    const leaky = Object.assign(new Error("SECRET-PROMPT in /Users/someone/repo for a@example.com"), {
      statusCode: 400,
      responseBody: "Details: SECRET-PROMPT /Users/someone/repo a@example.com",
    });
    noteTurnStreamError(nextChat, classifyTurnError(leaky));
    trackTurnCompleted(
      base({ end: classifyTurnEnd(leaky, new AbortController().signal), outputTokens: 0 }),
      async () => "cloud",
    );
    await flush();
    const body = JSON.stringify(captured);
    for (const s of ["SECRET-PROMPT", "/Users/", "@example.com", "Details:"]) expect(body).not.toContain(s);
  });

  it("the old per-turn events are gone", async () => {
    expect("trackModelTurn" in analytics).toBe(false);
    expect("trackTaskCompleted" in analytics).toBe(false);
    trackTurnCompleted(base());
    await flush();
    expect(captured.map((c) => c.event)).not.toContain("model_turn");
  });

  it("billingOf: Core, own key, or a local model", () => {
    expect(billingOf("compass")).toBe("core");
    expect(billingOf("ollama", "local")).toBe("local");
    expect(billingOf("openai")).toBe("byok");
  });

  it("a stub host is honoured only on this machine", () => {
    expect(analytics.posthogHost("http://127.0.0.1:9461")).toBe("http://127.0.0.1:9461");
    expect(analytics.posthogHost("http://localhost:9461/")).toBe("http://localhost:9461");
    expect(analytics.posthogHost("https://evil.example")).toBe("https://eu.i.posthog.com");
    expect(analytics.posthogHost("http://127.0.0.1.evil.example")).toBe("https://eu.i.posthog.com");
    expect(analytics.posthogHost(undefined)).toBe("https://eu.i.posthog.com");
  });

  it("nothing when the host editor's telemetry is off", async () => {
    process.env.ATLARIX_HOST_TELEMETRY = "off";
    try {
      trackTurnCompleted(base());
      analytics.capture("x");
      await flush();
      expect(captured).toEqual([]);
    } finally {
      delete process.env.ATLARIX_HOST_TELEMETRY;
    }
  });
});
