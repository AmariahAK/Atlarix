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

  it("says when it resets and what to do, and is not reported as our outage", () => {
    const c = classifyCompassFailure(429, body);
    expect(c.message).toMatch(/free Atlarix Auto share is used up/);
    expect(c.message).toMatch(/about 5 hours/);
    expect(c.isCompassInfraError).toBe(false);
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
    ).toEqual({ servedModel: "gpt-5.4-mini", freeRemaining: 62 });
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
