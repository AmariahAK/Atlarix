/**
 * Atlarix Auto on the client: offered only when the hosted config says so,
 * never a default or a fallback, never silently swapped for a paid tier, and
 * its limit reads as a limit — not as an outage, and not as something to retry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron-log", () => ({
  default: { scope: () => ({ info: () => {}, warn: () => {} }) },
}));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { parseCoreAuto } from "@/lib/routing/core-model-overrides";
import {
  __resetCoreModelOverridesForTests,
  setCoreAuto,
  setCoreModelOverrides,
} from "@/ipc/shared/core-model-override-store";
import {
  CORE_TIER_AUTO,
  getCompassSyntheticModels,
  getCoreModelIdForCoreTier,
  getFirstConfiguredCoreTier,
  isCoreAutoTier,
  resolveConfiguredCoreTier,
} from "@/ipc/shared/compass_constants";
import { classifyCompassFailure } from "@/lib/chat/compass-failure-classifier";
import { isNetworkStreamError } from "@/ipc/handlers/chat_stream/network-retry";
import { autoStatusFromHeaders } from "@/main/auto-status";
import {
  AUTO_CONSENT_MARKER,
  CORE_EXHAUSTED_MARKER,
  FREE_LIMIT_MARKER,
  FREE_BUSY_MARKER,
} from "@/shared/billing_copy";
import { autoRequestHeaders } from "@/ipc/utils/get_model_client";

beforeEach(() => {
  __resetCoreModelOverridesForTests();
  setCoreModelOverrides({ "core-1": "z-ai/glm-5.3", "core-3": "openai/gpt-6-astra" });
});

describe("the hosted auto block", () => {
  it("yields the wire id and label, defaulting the label", () => {
    expect(parseCoreAuto({ auto: { id: "atlarix/auto", label: "Free" } })).toEqual({
      id: "atlarix/auto",
      label: "Free",
    });
    expect(parseCoreAuto({ auto: { id: "atlarix/auto" } })?.label).toBe("Atlarix Auto");
    expect(parseCoreAuto({ auto: { label: "no id" } })).toBeNull();
    expect(parseCoreAuto({ models: {} })).toBeNull();
  });
});

describe("the Auto tier", () => {
  it("is listed first in Core only while offered", () => {
    expect(getCompassSyntheticModels().map((m) => m.apiName)).not.toContain(CORE_TIER_AUTO);
    setCoreAuto({ id: "atlarix/auto", label: "Atlarix Auto" });
    expect(getCompassSyntheticModels()[0]).toMatchObject({
      apiName: CORE_TIER_AUTO,
      displayName: "Atlarix Auto",
    });
  });

  it("dispatches as the proxy's wire id", () => {
    setCoreAuto({ id: "atlarix/auto", label: "Atlarix Auto" });
    expect(getCoreModelIdForCoreTier(CORE_TIER_AUTO)).toBe("atlarix/auto");
    expect(isCoreAutoTier("core-auto")).toBe(true);
    expect(isCoreAutoTier("core-1")).toBe(false);
  });

  it("is never the default a caller with no opinion gets", () => {
    setCoreAuto({ id: "atlarix/auto", label: "Atlarix Auto" });
    expect(getFirstConfiguredCoreTier()).toBe("core-3");
  });

  it("when withdrawn, a saved Auto selection does NOT fall onto a paid tier", () => {
    // Every other tier costs money; moving a user who chose "free" onto one is
    // a charge they never agreed to.
    expect(resolveConfiguredCoreTier(CORE_TIER_AUTO)).toBeUndefined();
  });
});

describe("Auto's limit is a limit", () => {
  const body = JSON.stringify({
    error: "free_usage_limit",
    retry_after_seconds: 5 * 3600,
    upgrade: "pro",
  });

  it("says when it resets and the ways to keep going, and is not our outage", () => {
    const c = classifyCompassFailure(429, body);
    expect(c.message).toContain(FREE_LIMIT_MARKER);
    expect(c.message).toMatch(/^Today's free Atlarix Auto is used up\. Resets in (4h 59m|5h)\. Keep going with Pro \(\$19\/month\) or credit \(from \$10\), or use your own key \(free\)\.$/);
    expect(c.isCompassInfraError).toBe(false);
    expect(c.freeAutoResetsAt).toBeGreaterThan(Date.now() + 4 * 3600 * 1000);
  });

  it("counts down to the proxy's resets_at when it sends one", () => {
    const resetsAt = new Date(Date.now() + (2 * 60 + 30) * 60_000).toISOString();
    const c = classifyCompassFailure(429, JSON.stringify({ error: "free_usage_limit", resets_at: resetsAt, retry_after_seconds: 1 }));
    expect(c.freeAutoResetsAt).toBe(Date.parse(resetsAt));
    expect(c.message).toMatch(/Resets in 2h 3\dm\./);
  });

  it("busy is not the limit: no countdown, and the same ways out", () => {
    const c = classifyCompassFailure(503, JSON.stringify({ error: "free_busy" }));
    expect(c.message).toContain(FREE_BUSY_MARKER);
    expect(c.message).not.toContain(FREE_LIMIT_MARKER);
    expect(c.message).toMatch(/Pro \(\$19\/month\) or credit \(from \$10\), or use your own key/);
    expect(c.freeAutoResetsAt).toBeUndefined();
  });

  it("a paid 429 core_rate_limited says the model is busy, not the balance or an outage", () => {
    const c = classifyCompassFailure(429, JSON.stringify({ error: "core_rate_limited", retry_after_seconds: 40 }));
    expect(c.message).toBe("This model is busy. Try again in 40s, or pick another model.");
    expect(c.isCompassInfraError).toBe(false);
    expect(c.freeAutoResetsAt).toBeUndefined();
  });

  it("a 402 that offers free Auto asks for consent instead of a top-up", () => {
    const c = classifyCompassFailure(
      402,
      JSON.stringify({ error: "insufficient_credit", free_available: true, consent_required: true }),
    );
    expect(c.message).toContain(AUTO_CONSENT_MARKER);
    expect(c.message).not.toContain(CORE_EXHAUSTED_MARKER);
  });

  it("is never retried — Retry-After is hours, and a retry reads as a disconnect", () => {
    const err = Object.assign(new Error("Too Many Requests"), {
      name: "APICallError",
      statusCode: 429,
      isRetryable: true,
      responseBody: body,
    });
    expect(isNetworkStreamError(err)).toBe(false);
  });

  it("a busy free model says busy, not unavailable", () => {
    const c = classifyCompassFailure(503, JSON.stringify({ error: "free_busy" }));
    expect(c.message).toMatch(/busy/);
    expect(c.isCompassInfraError).toBe(false);
  });

  it("free_busy and core_rate_limited are never retried — one send, one request", () => {
    for (const [statusCode, code] of [[503, "free_busy"], [429, "core_rate_limited"]] as const) {
      const err = Object.assign(new Error("gate"), {
        name: "APICallError",
        statusCode,
        isRetryable: true,
        responseBody: JSON.stringify({ error: code, retry_after_seconds: 30 }),
      });
      expect(isNetworkStreamError(err)).toBe(false);
      // Delivered inside the SDK's `{ error }` envelope, the same.
      expect(isNetworkStreamError({ error: err })).toBe(false);
    }
  });

  it("any other 503 — the edge, or core_unavailable — is still retried", () => {
    for (const body of ["", "<html>Bad gateway</html>", JSON.stringify({ error: "core_unavailable" })]) {
      const err = Object.assign(new Error("Service Unavailable"), {
        name: "APICallError",
        statusCode: 503,
        isRetryable: true,
        responseBody: body,
      });
      expect(isNetworkStreamError(err)).toBe(true);
    }
  });

  it("an ordinary 429 is still retried", () => {
    const err = Object.assign(new Error("rate"), {
      name: "APICallError",
      statusCode: 429,
      isRetryable: true,
      responseBody: "{}",
    });
    expect(isNetworkStreamError(err)).toBe(true);
  });
});

describe("the live readout", () => {
  it("reads the served model and free share from the proxy's headers", () => {
    expect(
      autoStatusFromHeaders(
        new Headers({
          "x-atlarix-served-model": "gpt-5.4-mini",
          "x-atlarix-free-remaining": "62",
        }),
      ),
    ).toEqual({ servedModel: "gpt-5.4-mini", freeRemaining: 62, billing: null, tier: null, costCents: null, onFloor: null });
    // Auto or Zenith, for the Usage page's Auto picks.
    expect(
      autoStatusFromHeaders(new Headers({ "x-atlarix-billing": "paid", "x-atlarix-tier": " Zenith " }))?.tier,
    ).toBe("zenith");
    expect(
      autoStatusFromHeaders(
        new Headers({ "x-atlarix-billing": "free", "x-atlarix-free-remaining": "0", "x-atlarix-free-floor": "1" }),
      ),
    ).toMatchObject({ onFloor: true, freeRemaining: 0 });
    expect(
      autoStatusFromHeaders(new Headers({ "x-atlarix-billing": "free", "x-atlarix-free-floor": "0" })),
    ).toMatchObject({ onFloor: false });
    expect(
      autoStatusFromHeaders(new Headers({ "x-atlarix-billing": "paid", "x-atlarix-cost-cents": "3" })),
    ).toMatchObject({ billing: "paid", costCents: 3 });
    expect(autoStatusFromHeaders(new Headers())).toBeNull();
  });
});

describe("Auto's identity and capabilities", () => {
  it("is named Atlarix Auto everywhere, never '(openrouter)'", async () => {
    const { buildAtlarixCoreTierCatalog, resolveAtlarixCoreIdentity, displayLabelForCompassTier } =
      await import("@/lib/atlarix-core-catalog");
    setCoreAuto({ id: "atlarix/auto", label: "Atlarix Auto" });
    const catalog = buildAtlarixCoreTierCatalog();
    expect(catalog[0]).toMatchObject({ internalTierId: "core-auto", labelWithProvider: "Atlarix Auto" });
    const id = resolveAtlarixCoreIdentity("core-auto", catalog);
    expect(id.labelWithProvider).toBe("Atlarix Auto");
    expect(JSON.stringify(id)).not.toMatch(/openrouter/);
    // The loading-time fallback (no catalog yet) too.
    expect(displayLabelForCompassTier("core-auto")).toBe("Atlarix Auto");
    expect(displayLabelForCompassTier("core-3")).not.toMatch(/openrouter/);
  });

  it("lists the models the Usage page may name: concrete rungs, paid and Zenith levels, Core slots, never a gateway", () => {
    const parsed = parseCoreAuto({
      routing: { "core-1": { provider: "anthropic", apiModelId: "claude-sonnet-5-5" } },
      auto: {
        id: "atlarix/auto",
        chain: [
          { provider: "openai-shared", apiModelId: "gpt-5.4-mini", pool: "mini" },
          { provider: "openrouter-free", apiModelId: "openrouter/free", pool: "openrouter", pinServed: true },
          { provider: "requesty-free", apiModelId: "discover", pool: "requesty", discover: true },
        ],
        paid: { levels: { low: [{ provider: "anthropic", apiModelId: "claude-haiku-5-5" }] } },
        zenith: {
          levels: {
            max: [
              { provider: "openai", apiModelId: "gpt-6.1-astra" },
              { provider: "bedrock", apiModelId: "us.anthropic.claude-opus-5-5-v1:0" },
            ],
          },
        },
      },
    });
    expect(parsed?.nameableModels?.sort()).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "gpt-5.4-mini",
      "gpt-6.1-astra",
    ]);
  });

  it("takes reasoning/vision capability from the first rung (shared suffix stripped)", async () => {
    const { getCoreModelsDevTargetForTier } = await import("@/ipc/shared/compass_constants");
    setCoreAuto(
      parseCoreAuto({
        auto: {
          id: "atlarix/auto",
          chain: [{ provider: "openai-shared", apiModelId: "gpt-5.4-mini", pool: "mini" }],
        },
      }),
    );
    expect(getCoreModelsDevTargetForTier("core-auto")).toEqual({
      providerId: "openai",
      modelId: "gpt-5.4-mini",
    });
  });
});

describe("the routing hints", () => {
  it("carry purpose, mode, escalate — and consent only once given", () => {
    expect(
      autoRequestHeaders(
        { deepThinking: true, atlarixAutoConsentAt: undefined },
        { purpose: "main", workMode: "plan" },
      ),
    ).toEqual({
      "X-Atlarix-Purpose": "main",
      "X-Atlarix-Mode": "plan",
    });
    const h = autoRequestHeaders(
      { deepThinking: false, atlarixAutoConsentAt: "2026-09-23T00:00:00Z" },
      { delegationRole: "subagent", escalate: true },
    );
    expect(h).toMatchObject({
      "X-Atlarix-Purpose": "subagent",
      "X-Atlarix-Escalate": "1",
      "X-Atlarix-Free-Consent": "1",
    });
  });

  it("carry no effort or thinking hint: a saved level can't steer lanes the user can't see (owner, 2026-10-29)", () => {
    for (const effort of ["low", "medium", "max", "xhigh", undefined]) {
      const h = autoRequestHeaders({ effort, deepThinking: true });
      expect(h).not.toHaveProperty("X-Atlarix-Effort");
      expect(h).not.toHaveProperty("X-Atlarix-Thinking");
    }
  });
});

describe("Auto's context window follows the account", () => {
  const RAW = {
    auto: {
      id: "atlarix/auto",
      chain: [
        { provider: "openai-shared", apiModelId: "gpt-5.4-mini", pool: "mini" },
        { provider: "zai", apiModelId: "glm-4.7-flash", pool: "floor" },
      ],
      paid: {
        levels: {
          glm: [{ provider: "zai", apiModelId: "glm-5.3" }],
          sol: [{ provider: "openai", apiModelId: "gpt-6-sol" }],
        },
      },
    },
  };

  it("parses the free set without the $0 floor, and the paid set from every level", () => {
    const auto = parseCoreAuto(RAW)!;
    expect(auto.freeModels).toEqual([{ providerId: "openai", modelId: "gpt-5.4-mini" }]);
    expect(auto.paidModels).toEqual([
      { providerId: "zai", modelId: "glm-5.3" },
      { providerId: "openai", modelId: "gpt-6-sol" },
    ]);
  });

  it("is the smallest window among the models that could answer — free until a paid reply says otherwise", async () => {
    const windows: Record<string, number> = {
      "openai/gpt-5.4-mini": 400_000,
      "zai/glm-5.3": 1_000_000,
      "openai/gpt-6-sol": 1_050_000,
    };
    vi.doMock("@/lib/models_dev", () => ({
      getModelsDevLimits: async (p: string, m: string) => ({ context: windows[`${p}/${m}`] }),
    }));
    const { autoContextWindow, noteAutoBilling, __resetAutoBilling } = await import(
      "@/lib/context/auto-context-window"
    );
    setCoreAuto(parseCoreAuto(RAW)!);
    __resetAutoBilling("pro-account");
    // Free (and unknown) is the free working window, 200K, not mini's 400K.
    expect(await autoContextWindow()).toBe(200_000); // unknown → free window
    await noteAutoBilling("paid");
    expect(await autoContextWindow()).toBe(1_000_000);
    await noteAutoBilling("free");
    expect(await autoContextWindow()).toBe(200_000);
    await noteAutoBilling("paid");
    // Another account signs in: its own answer, not the previous account's…
    const mod = await import("@/lib/context/auto-context-window");
    mod.__setAccountForTests("free-account");
    expect(await autoContextWindow()).toBe(200_000);
    // …and switching back remembers the paying account.
    mod.__setAccountForTests("pro-account");
    expect(await autoContextWindow()).toBe(1_000_000);
    vi.doUnmock("@/lib/models_dev");
  });
});

/**
 * Free Auto's FIXED working window (owner, 2026-11-07). The free set's own
 * windows say 400K (gpt-5.4-mini), but the gateway models the mix sends a free
 * step to have no models.dev row and hold ~200K, as does the $0 floor. A free
 * chat compacting against 400K (or the 256K working cap: ~192K) fit none of
 * them. 200K from the hosted `auto.freeWorkingWindowTokens`, else this app's
 * constant; it caps whatever the 256k/512k/full setting says. Paid unchanged.
 */
describe("free Auto's working window", () => {
  const RAW = {
    auto: {
      id: "atlarix/auto",
      chain: [
        { provider: "openai-shared", apiModelId: "gpt-5.4-mini", pool: "mini" },
        { provider: "openrouter-free", apiModelId: "openrouter/free", pool: "openrouter", pinServed: true },
        { provider: "requesty-free", apiModelId: "discover", pool: "requesty", discover: true },
        { provider: "zai", apiModelId: "glm-4.7-flash", pool: "floor" },
      ],
      paid: { levels: { glm: [{ provider: "zai", apiModelId: "glm-5.3" }] } },
    },
  };
  const WINDOWS: Record<string, number> = {
    "openai/gpt-5.4-mini": 400_000,
    "zai/glm-5.3": 1_000_000,
  };

  async function windowFor(billing: "free" | "paid" | null, raw: unknown = RAW, windows = WINDOWS) {
    vi.doMock("@/lib/models_dev", () => ({
      getModelsDevLimits: async (p: string, m: string) => ({ context: windows[`${p}/${m}`] }),
    }));
    const mod = await import("@/lib/context/auto-context-window");
    setCoreAuto(parseCoreAuto(raw)!);
    mod.__resetAutoBilling(`acct-${billing ?? "unknown"}`);
    if (billing) await mod.noteAutoBilling(billing);
    const w = await mod.autoContextWindow();
    vi.doUnmock("@/lib/models_dev");
    return w;
  }

  it("reads the hosted window, and ignores one that is not a positive whole number", () => {
    const withWindow = (v: unknown) => parseCoreAuto({ auto: { ...RAW.auto, freeWorkingWindowTokens: v } });
    expect(withWindow(180_000)?.freeWorkingWindowTokens).toBe(180_000);
    for (const bad of [0, -5, "200000", null, 1.5, Number.NaN]) {
      expect(withWindow(bad)).not.toHaveProperty("freeWorkingWindowTokens");
    }
  });

  it("is 200K for a free account, and for one whose billing is not known yet, with no hosted value", async () => {
    expect(await windowFor("free")).toBe(200_000);
    expect(await windowFor(null)).toBe(200_000);
  });

  it("follows the hosted value", async () => {
    expect(await windowFor("free", { auto: { ...RAW.auto, freeWorkingWindowTokens: 180_000 } })).toBe(180_000);
  });

  it("keeps a free model's real window when that is smaller", async () => {
    expect(await windowFor("free", RAW, { ...WINDOWS, "openai/gpt-5.4-mini": 128_000 })).toBe(128_000);
  });

  it("is 200K even when no free model has a models.dev row (gateways only)", async () => {
    expect(await windowFor("free", RAW, { "zai/glm-5.3": 1_000_000 })).toBe(200_000);
  });

  it("leaves a paying account on its own models' window", async () => {
    expect(await windowFor("paid")).toBe(1_000_000);
    expect(await windowFor("paid", { auto: { ...RAW.auto, freeWorkingWindowTokens: 180_000 } })).toBe(1_000_000);
  });

  it("compacts a free chat at 0.75 x 200K = 150K, even on the 'full' setting; paid stays on the 256K cap", async () => {
    const { contextWorkingWindowTokens, compactionPoint } = await import("@/lib/context/mid-loop-threshold");
    const { resolveModelContextLimit } = await import("@/lib/context/resolve-model-context-limit");
    const auto = { provider: "compass", name: "core-auto" } as never;
    const point = async (billing: "free" | "paid", setting: "256k" | "512k" | "full") => {
      vi.doMock("@/lib/models_dev", () => ({
        getModelsDevLimits: async (p: string, m: string) => ({ context: WINDOWS[`${p}/${m}`] }),
      }));
      const mod = await import("@/lib/context/auto-context-window");
      setCoreAuto(parseCoreAuto(RAW)!);
      mod.__resetAutoBilling(`acct-${billing}`);
      await mod.noteAutoBilling(billing);
      const raw = (await resolveModelContextLimit(auto, {} as never)).rawContextLength!;
      vi.doUnmock("@/lib/models_dev");
      const working = contextWorkingWindowTokens(raw, setting);
      return { raw, working, at: compactionPoint({ usableTokens: raw - 16_384, workingWindowTokens: working, threshold: 0.75 }) };
    };
    expect(await point("free", "256k")).toEqual({ raw: 200_000, working: 200_000, at: 150_000 });
    expect(await point("free", "full")).toEqual({ raw: 200_000, working: 200_000, at: 150_000 });
    expect(await point("free", "512k")).toEqual({ raw: 200_000, working: 200_000, at: 150_000 });
    expect(await point("paid", "256k")).toEqual({ raw: 1_000_000, working: 256_000, at: 192_000 });
  });

  it("is what the context ring reads against for a free account", async () => {
    vi.doMock("@/lib/models_dev", () => ({
      getModelsDevLimits: async (p: string, m: string) => ({ context: WINDOWS[`${p}/${m}`] }),
    }));
    const mod = await import("@/lib/context/auto-context-window");
    setCoreAuto(parseCoreAuto(RAW)!);
    mod.__resetAutoBilling("acct-ring");
    await mod.noteAutoBilling("free");
    const { getContextWindowDetailed } = await import("@/ipc/utils/token_utils");
    const ring = await getContextWindowDetailed({ provider: "compass", name: "core-auto" } as never);
    vi.doUnmock("@/lib/models_dev");
    expect(ring.contextWindow).toBe(200_000);
  });
});
