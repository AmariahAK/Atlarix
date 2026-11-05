/**
 * The account's usage counts (client_usage_daily): one row per day, surface,
 * billing, provider type and model, summed in memory and sent in one call,
 * never per message. Counts only, a provider the user named never appears,
 * off with the host editor's telemetry, and a failed send loses nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/atlarix-usage-rollup-test", getVersion: () => "15.9.9" } }));
vi.mock("@/main/settings", () => ({ readSettings: () => ({ telemetryConsent: "opted_out" }), writeSettings: () => {} }));

const rollup = await import("@/lib/analytics/usage-rollup");
const { recordTurnUsage, flushClientUsage, __setUsageSenderForTests, __pendingUsageRowsForTests, FLUSH_AFTER_MS } = rollup;

const flush = () => new Promise((r) => setTimeout(r, 0));
const at = new Date("2026-10-21T12:00:00Z");
const ok = { end: { outcome: "ok" as const }, tokensIn: 100, tokensOut: 20, at };
const cloud = async () => ({ type: "cloud" });

let sent: Array<Array<Record<string, unknown>>> = [];
beforeEach(() => {
  sent = [];
  delete process.env.ATLARIX_HOST_TELEMETRY;
  delete process.env.ATLARIX_REPORT_SURFACE;
  __setUsageSenderForTests(async (rows) => {
    sent.push(rows as never);
    return true;
  });
});
afterEach(() => {
  vi.useRealTimers();
  __setUsageSenderForTests(null);
});

describe("usage counts", () => {
  it("sum per row and go in one call", async () => {
    recordTurnUsage({ ...ok, provider: "openai", model: "gpt-5" }, cloud);
    recordTurnUsage({ ...ok, provider: "openai", model: "gpt-5", end: { outcome: "error", errorKind: "provider_5xx" } }, cloud);
    recordTurnUsage({ ...ok, provider: "ollama", model: "qwen3" }, async () => ({ type: "local" }));
    await flush();
    await flushClientUsage();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual([
      expect.objectContaining({
        day: "2026-10-21",
        surface: "app",
        editor: "",
        billing: "byok",
        provider_type: "openai",
        model: "gpt-5",
        turns: 2,
        failed_turns: 1,
        last_error_kind: "provider_5xx",
        tokens_in: 200,
        tokens_out: 40,
      }),
      expect.objectContaining({ billing: "local", provider_type: "ollama", model: "qwen3", turns: 1, failed_turns: 0 }),
    ]);
  });

  it("a turn refused at a gate (no credit) is counted as gated: not a success, not an error (2026-11-05 audit)", async () => {
    recordTurnUsage({ ...ok, provider: "openai", model: "gpt-5" }, cloud);
    recordTurnUsage(
      { ...ok, provider: "openai", model: "gpt-5", end: { outcome: "gate", gateKind: "insufficient_credit", errorKind: "quota" } as never },
      cloud,
    );
    await flush();
    await flushClientUsage();
    expect(sent[0]).toEqual([
      expect.objectContaining({ model: "gpt-5", turns: 2, failed_turns: 0, gated_turns: 1, last_gate_kind: "insufficient_credit" }),
    ]);
    expect(sent[0]![0]).not.toHaveProperty("last_error_kind");
  });

  it("Core says which: Auto free / paid, or a Core model", async () => {
    recordTurnUsage({ ...ok, provider: "compass", model: "core-auto", end: { outcome: "ok", autoBilling: "paid" } }, cloud);
    recordTurnUsage({ ...ok, provider: "compass", model: "core-auto", end: { outcome: "error", errorKind: "quota" } }, cloud);
    recordTurnUsage({ ...ok, provider: "compass", model: "core-2" }, cloud);
    // A gate is a turn, not a failed turn.
    recordTurnUsage({ ...ok, provider: "compass", model: "core-2", end: { outcome: "gate", gateKind: "insufficient_credit", errorKind: "quota", httpStatus: 402 } }, cloud);
    await flush();
    await flushClientUsage();
    expect(sent[0]!.map((r) => r.billing)).toEqual(["auto_paid", "auto", "core"]);
    expect(sent[0]![2]).toMatchObject({ turns: 2, failed_turns: 0 });
  });

  it("a provider the user added is its type only", async () => {
    recordTurnUsage({ ...ok, provider: "custom::jane-work-gateway", model: "glm-4.7" }, async () => ({
      type: "custom",
      apiFormat: "anthropic",
    }));
    await flush();
    await flushClientUsage();
    expect(sent[0]![0]).toMatchObject({ provider_type: "custom:anthropic", billing: "byok" });
    expect(JSON.stringify(sent)).not.toContain("jane-work");
  });

  it("is sent once, 15 minutes after the first turn, not per turn", async () => {
    vi.useFakeTimers();
    recordTurnUsage({ ...ok, provider: "openai", model: "gpt-5" }, cloud);
    await vi.advanceTimersByTimeAsync(0);
    recordTurnUsage({ ...ok, provider: "openai", model: "gpt-5" }, cloud);
    await vi.advanceTimersByTimeAsync(FLUSH_AFTER_MS - 1000);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toMatchObject({ turns: 2 });
    // Idle: nothing more.
    await vi.advanceTimersByTimeAsync(FLUSH_AFTER_MS * 3);
    expect(sent).toHaveLength(1);
  });

  it("a failed send keeps the counts for the next one", async () => {
    __setUsageSenderForTests(async () => false);
    recordTurnUsage({ ...ok, provider: "openai", model: "gpt-5" }, cloud);
    await flush();
    await flushClientUsage();
    recordTurnUsage({ ...ok, provider: "openai", model: "gpt-5" }, cloud);
    await flush();
    expect(__pendingUsageRowsForTests()).toEqual([expect.objectContaining({ turns: 2 })]);
  });

  it("nothing when the editor's telemetry is off, for a stopped turn, or with no model", async () => {
    process.env.ATLARIX_HOST_TELEMETRY = "off";
    recordTurnUsage({ ...ok, provider: "openai", model: "gpt-5" }, cloud);
    delete process.env.ATLARIX_HOST_TELEMETRY;
    recordTurnUsage({ ...ok, provider: "openai", model: "gpt-5", end: { outcome: "stopped" } }, cloud);
    recordTurnUsage({ ...ok, end: { outcome: "error", errorKind: "auth" } }, cloud);
    await flush();
    await flushClientUsage();
    expect(sent).toEqual([]);
  });

  it("an editor's turns say which surface and editor", async () => {
    process.env.ATLARIX_REPORT_SURFACE = "acp";
    process.env.ATLARIX_ACP_EDITOR = "zed";
    recordTurnUsage({ ...ok, provider: "openai", model: "gpt-5" }, cloud);
    await flush();
    delete process.env.ATLARIX_REPORT_SURFACE;
    delete process.env.ATLARIX_ACP_EDITOR;
    await flushClientUsage();
    expect(sent[0]![0]).toMatchObject({ surface: "acp", editor: "zed" });
  });
});
