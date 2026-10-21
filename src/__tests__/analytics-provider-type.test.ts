/**
 * Who uses what, without anything the user typed (2026-10-21):
 * - `provider_type` on every turn: the built-in id, or `custom:<api format>`;
 * - a provider the user added reports as `custom`, never its own id (free text)
 *   or address;
 * - `core_plan` tells Atlarix Auto free / paid from a Core model, from THIS
 *   chat's own Auto reply (`billing` keeps its values: dashboards break down by it);
 * - the funnel events carry the model;
 * - `model_connected` has one shape everywhere, Core sign-in included.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
let consent = "opted_in";
let store: Record<string, unknown> = {};
vi.mock("electron", () => ({ app: { getPath: () => "/tmp/atlarix-analytics-test", getVersion: () => "15.9.9" } }));
vi.mock("posthog-node", () => ({
  PostHog: class {
    alias() {}
    identify() {}
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
const { trackTurnCompleted, trackModelConnected, identifyUser } = analytics;
const { noteTurnAutoBilling } = await import("@/lib/analytics/turn-stats");

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

const events = (name: string) => captured.filter((c) => c.event === name).map((c) => c.properties);

describe("provider_type and custom providers", () => {
  it("a built-in provider is its own type", async () => {
    trackTurnCompleted(base(), async () => ({ type: "cloud" }));
    await flush();
    expect(turns()[0]).toMatchObject({ provider: "deepseek", provider_type: "deepseek", billing: "byok" });
  });

  it("a provider the user added is `custom` with its API format, and its id never appears", async () => {
    trackTurnCompleted(base({ provider: "custom::acme-corp-bedrock", model: "claude-haiku-4-5" }), async () => ({
      type: "custom",
      apiFormat: "anthropic",
    }));
    await flush();
    expect(turns()[0]).toMatchObject({ provider: "custom", provider_type: "custom:anthropic", billing: "byok" });
    expect(turns()[0]!.$set).toMatchObject({ last_provider: "custom" });
    expect(JSON.stringify(captured)).not.toContain("acme-corp");
  });
});

describe("core_plan", () => {
  it("Auto free and paid come from each chat's own reply, a Core model is core", async () => {
    const free = nextChat;
    const paid = nextChat + 500;
    const core = nextChat + 900;
    noteTurnAutoBilling(free, "free");
    noteTurnAutoBilling(paid, "paid");
    trackTurnCompleted(base({ chatId: paid, provider: "compass", model: "core-auto" }), async () => ({ type: "cloud" }));
    trackTurnCompleted(base({ chatId: free, provider: "compass", model: "core-auto" }), async () => ({ type: "cloud" }));
    trackTurnCompleted(base({ chatId: core, provider: "compass", model: "core-2" }), async () => ({ type: "cloud" }));
    await flush();
    expect(turns().map((t) => [t.billing, t.core_plan])).toEqual([
      ["core", "auto_paid"],
      ["core", "auto_free"],
      ["core", "core"],
    ]);
  });

  it("not on Core: no core_plan", async () => {
    trackTurnCompleted(base(), async () => ({ type: "cloud" }));
    await flush();
    expect(turns()[0]).not.toHaveProperty("core_plan");
  });
});

describe("the funnel events", () => {
  it("carry the model, provider type and plan", async () => {
    store = {};
    noteTurnAutoBilling(nextChat, "free");
    trackTurnCompleted(base({ provider: "compass", model: "core-auto" }), async () => ({ type: "cloud" }));
    await flush();
    for (const e of ["first_task_started", "first_task_completed"]) {
      expect(events(e)[0], e).toMatchObject({ model: "core-auto", provider_type: "compass", core_plan: "auto_free" });
    }
  });
});

describe("model_connected", () => {
  it("one shape: a custom provider as custom, its format looked up only when sent", async () => {
    const lookup = vi.fn(async () => "anthropic");
    trackModelConnected({ type: "custom", provider: "custom::my-gateway-ai2a", apiFormat: lookup });
    trackModelConnected({ type: "byok", provider: "openai" });
    await flush();
    expect(events("model_connected")).toHaveLength(2);
    expect(events("model_connected")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "custom", provider: "custom", provider_type: "custom:anthropic" }),
        expect.objectContaining({ type: "byok", provider: "openai", provider_type: "openai" }),
      ]),
    );
    expect(JSON.stringify(captured)).not.toContain("my-gateway");
  });

  it("adding a provider and then its key is one connection", async () => {
    trackModelConnected({ type: "custom", provider: "custom::twice-ai2a" });
    trackModelConnected({ type: "custom", provider: "custom::twice-ai2a" });
    await flush();
    expect(events("model_connected")).toHaveLength(1);
  });

  it("opted out: nothing sent and nothing looked up", async () => {
    consent = "opted_out";
    const lookup = vi.fn(async () => "openai");
    trackModelConnected({ type: "custom", provider: "custom::off-ai2a", apiFormat: lookup });
    await flush();
    expect(captured).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("an account's first sign-in on this install connects Core, once", async () => {
    identifyUser("user-ai2a-1", { email: "someone@example.com" });
    identifyUser("user-ai2a-1", { email: "someone@example.com" });
    await flush();
    expect(events("model_connected")).toEqual([
      expect.objectContaining({ type: "core", provider: "compass", provider_type: "compass" }),
    ]);
  });
});

describe("how the turn really ended", () => {
  it("is returned whatever the consent, for the crash report", async () => {
    consent = "opted_out";
    const { noteTurnStreamError } = await import("@/lib/analytics/turn-stats");
    noteTurnStreamError(nextChat, { kind: "bad_request", httpStatus: 400 });
    const end = trackTurnCompleted(base({ end: { outcome: "error", errorKind: "no_output" }, outputTokens: 0 }));
    expect(end).toEqual({ outcome: "error", errorKind: "bad_request", httpStatus: 400 });
    await flush();
    expect(captured).toEqual([]);
  });
});
