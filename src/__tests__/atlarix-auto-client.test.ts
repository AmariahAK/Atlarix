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
  freeUsageLimitUserMessage,
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

  it("says come back tomorrow and when it resets, nothing more, and is not our outage", () => {
    const c = classifyCompassFailure(429, body);
    expect(c.message).toContain(FREE_LIMIT_MARKER);
    expect(c.message).toMatch(/^Today's usage is over\. Come back tomorrow \(it resets at \d{1,2}:\d{2}/);
    expect(c.message).not.toMatch(/credit|Pro|API key/);
    expect(c.isCompassInfraError).toBe(false);
  });

  it("names the reset on the user's own clock — 00:00 UTC is 3:00 AM in Nairobi", () => {
    const midnightUtc = Date.UTC(2026, 8, 24, 0, 0, 0);
    const fiveHoursBefore = midnightUtc - 5 * 3600 * 1000;
    const m = freeUsageLimitUserMessage(5 * 3600, fiveHoursBefore, "Africa/Nairobi");
    // The hour, in whatever form this machine's locale writes it ("3:00 AM",
    // "03:00"): the time is the point, not the US format (it failed under en-GB).
    expect(m).toMatch(/resets at 0?3:00(\s?AM|\s?am)?\b/);
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
    ).toEqual({ servedModel: "gpt-5.4-mini", freeRemaining: 62, billing: null, costCents: null, onFloor: null });
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
  it("carry purpose, mode, deep thinking — and consent only once given", () => {
    expect(
      autoRequestHeaders(
        { deepThinking: true, atlarixAutoConsentAt: undefined },
        { purpose: "main", workMode: "plan" },
      ),
    ).toEqual({
      "X-Atlarix-Purpose": "main",
      "X-Atlarix-Effort": "max",
      "X-Atlarix-Thinking": "1",
      "X-Atlarix-Mode": "plan",
    });
    const h = autoRequestHeaders(
      { deepThinking: false, atlarixAutoConsentAt: "2026-09-23T00:00:00Z" },
      { delegationRole: "subagent", escalate: true },
    );
    expect(h).toMatchObject({
      "X-Atlarix-Purpose": "subagent",
      "X-Atlarix-Effort": "medium",
      "X-Atlarix-Thinking": "0",
      "X-Atlarix-Escalate": "1",
      "X-Atlarix-Free-Consent": "1",
    });
  });

  it("carry the /effort level for paid Auto's lanes, max also as the old thinking header", () => {
    expect(autoRequestHeaders({ effort: "low" })).toMatchObject({ "X-Atlarix-Effort": "low", "X-Atlarix-Thinking": "0" });
    expect(autoRequestHeaders({ effort: "max" })).toMatchObject({ "X-Atlarix-Effort": "max", "X-Atlarix-Thinking": "1" });
    // A level Auto doesn't have (another model's) runs Auto's default.
    expect(autoRequestHeaders({ effort: "xhigh" })).toMatchObject({ "X-Atlarix-Effort": "medium" });
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
    expect(await autoContextWindow()).toBe(400_000); // unknown → free window
    await noteAutoBilling("paid");
    expect(await autoContextWindow()).toBe(1_000_000);
    await noteAutoBilling("free");
    expect(await autoContextWindow()).toBe(400_000);
    await noteAutoBilling("paid");
    // Another account signs in: its own answer, not the previous account's…
    const mod = await import("@/lib/context/auto-context-window");
    mod.__setAccountForTests("free-account");
    expect(await autoContextWindow()).toBe(400_000);
    // …and switching back remembers the paying account.
    mod.__setAccountForTests("pro-account");
    expect(await autoContextWindow()).toBe(1_000_000);
    vi.doUnmock("@/lib/models_dev");
  });
});
