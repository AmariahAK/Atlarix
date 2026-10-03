/**
 * `model_turn`: usage counted by who pays for the model, so people on their own
 * key or a local model don't look like they dropped off. Opted-in only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
let consent = "opted_in";
vi.mock("electron", () => ({ app: { getPath: () => "/tmp/atlarix-analytics-test" } }));
vi.mock("posthog-node", () => ({
  PostHog: class {
    capture(e: { event: string; properties: Record<string, unknown> }) {
      captured.push(e);
    }
  },
}));
vi.mock("@/main/settings", () => ({
  readSettings: () => ({ telemetryConsent: consent, firstTaskStartedAt: 1, firstTaskCompletedAt: 1 }),
  writeSettings: () => {},
}));
vi.mock("../main/settings", () => ({
  readSettings: () => ({ telemetryConsent: consent, firstTaskStartedAt: 1, firstTaskCompletedAt: 1 }),
  writeSettings: () => {},
}));

process.env.POSTHOG_API_KEY = "phc_test";
const { billingOf, trackModelTurn, trackTaskCompleted } = await import("@/main/lib/analytics");

beforeEach(() => {
  captured.length = 0;
  consent = "opted_in";
});

describe("model_turn", () => {
  it("billing: Atlarix Core, your own key, or a local model", () => {
    expect(billingOf("compass")).toBe("core");
    expect(billingOf("ollama", "local")).toBe("local");
    expect(billingOf("deepseek", "cloud")).toBe("byok");
    expect(billingOf("openai")).toBe("byok");
  });

  it("an own-key turn: the event, and the person marked as using their own key", () => {
    trackModelTurn({ provider: "deepseek", providerType: "cloud", model: "deepseek-v4-pro", mode: "build" });
    const e = captured.find((c) => c.event === "model_turn")!;
    expect(e.properties).toMatchObject({ billing: "byok", provider: "deepseek", model: "deepseek-v4-pro", mode: "build" });
    expect(e.properties.$set).toMatchObject({ uses_byok: true, last_billing: "byok", last_provider: "deepseek" });
    expect((e.properties.$set_once as Record<string, unknown>).first_byok_at).toBeTruthy();
    // The funnel events carry it too.
    trackTaskCompleted({ mode: "build" });
    expect(captured.find((c) => c.event === "task_completed")!.properties).toMatchObject({ billing: "byok", provider: "deepseek" });
  });

  it("a fallback to Core counts as Core", () => {
    trackModelTurn({ provider: "compass", model: "core-1", fellBackToCore: true });
    expect(captured[0]!.properties).toMatchObject({ billing: "core", fell_back_to_core: true });
  });

  it("sends nothing without consent", () => {
    consent = "opted_out";
    trackModelTurn({ provider: "deepseek", model: "deepseek-v4-pro" });
    expect(captured).toEqual([]);
  });
});
