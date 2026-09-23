/**
 * Per-tier direct-provider routing from the hosted core-models.json, and the
 * models.dev coordinates Core resolves from it.
 *
 * Why this exists: Core used to reach its context window, price and capabilities
 * through the OpenRouter catalog, keyed by a `vendor/model` wire id. Once a tier
 * routes direct, that key matches nothing and a 1M-token window silently collapses to
 * a generic fallback. The `routing` block carries the vendor's exact model id so the
 * lookup keeps working — and it must be carried, not derived, because the wire id and
 * the catalog key differ in CASE for MiniMax.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsp from "node:fs/promises";

const { TMP } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path");
  return {
    TMP: path.join(
      os.tmpdir(),
      `atlarix-core-routing-${process.pid}-${Date.now()}`,
    ),
  };
});

vi.mock("@/paths/paths", () => ({ getUserDataPath: () => TMP }));
vi.mock("electron-log", () => ({
  default: { scope: () => ({ info: () => {}, warn: () => {} }) },
}));
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => [] } }));

import { refreshCoreModelOverrides } from "@/lib/routing/core-model-overrides";
import {
  setCoreModelOverrides,
  setCoreModelRouting,
  getCoreTierRouting,
  __resetCoreModelOverridesForTests,
} from "@/ipc/shared/core-model-override-store";
import {
  CORE_TIER_ORDER,
  DEFAULT_NEW_USER_CORE_TIER,
  DEFAULT_PAID_CORE_TIER,
  getCoreModelIdForCoreTier,
  getOpenRouterModelIdForCoreTier,
  getCoreModelsDevTargetForTier,
  getCompassSyntheticModels,
  getFirstConfiguredCoreTier,
  resolveConfiguredCoreTier,
} from "@/ipc/shared/compass_constants";
import { buildAtlarixCoreTierCatalog } from "@/lib/atlarix-core-catalog";

const ENV_KEYS = [
  "ATLARIX_CORE_MODEL_1",
  "ATLARIX_CORE_MODEL_2",
  "ATLARIX_CORE_MODEL_3",
  "ATLARIX_CORE_MODEL_4",
] as const;

function fetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => body });
}

let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  __resetCoreModelOverridesForTests();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  await fsp.rm(TMP, { recursive: true, force: true });
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
  __resetCoreModelOverridesForTests();
  await fsp.rm(TMP, { recursive: true, force: true });
});

describe("routing block parsing", () => {
  it("applies a well-formed routing entry", async () => {
    vi.stubGlobal(
      "fetch",
      fetchOk({
        models: { "core-3": "deepseek/deepseek-v4-pro" },
        routing: {
          "core-3": { provider: "deepseek", apiModelId: "deepseek-v4-pro" },
        },
      }),
    );
    await refreshCoreModelOverrides();
    expect(getCoreTierRouting("core-3")).toEqual({
      provider: "deepseek",
      apiModelId: "deepseek-v4-pro",
    });
  });

  it("leaves a tier unrouted when the block is absent (pre-migration shape)", async () => {
    vi.stubGlobal(
      "fetch",
      fetchOk({ models: { "core-1": "moonshotai/kimi-k3" } }),
    );
    await refreshCoreModelOverrides();
    expect(getCoreTierRouting("core-1")).toBeUndefined();
  });

  it("drops a half-specified entry rather than routing to a vendor with no model", async () => {
    vi.stubGlobal(
      "fetch",
      fetchOk({
        models: { "core-1": "a/b", "core-2": "c/d" },
        routing: {
          "core-1": { provider: "deepseek" }, // no apiModelId
          "core-2": { apiModelId: "x" }, // no provider
        },
      }),
    );
    await refreshCoreModelOverrides();
    expect(getCoreTierRouting("core-1")).toBeUndefined();
    expect(getCoreTierRouting("core-2")).toBeUndefined();
  });

  it("ignores unknown tier keys and non-object values", async () => {
    vi.stubGlobal(
      "fetch",
      fetchOk({
        models: { "core-1": "a/b" },
        routing: {
          "core-9": { provider: "p", apiModelId: "m" },
          "core-1": "not-an-object",
        },
      }),
    );
    await refreshCoreModelOverrides();
    expect(getCoreTierRouting("core-9")).toBeUndefined();
    expect(getCoreTierRouting("core-1")).toBeUndefined();
  });

  it("resolves legacy compass-* tier keys through the alias map", async () => {
    vi.stubGlobal(
      "fetch",
      fetchOk({
        models: { "compass-fast": "deepseek/deepseek-v4-pro" },
        routing: {
          "compass-fast": {
            provider: "deepseek",
            apiModelId: "deepseek-v4-pro",
          },
        },
      }),
    );
    await refreshCoreModelOverrides();
    expect(getCoreTierRouting("core-1")?.provider).toBe("deepseek");
  });

  it("trims whitespace so a stray space can't break the catalog lookup", async () => {
    vi.stubGlobal(
      "fetch",
      fetchOk({
        models: { "core-1": "moonshot/kimi-k3" },
        routing: {
          "core-1": { provider: "  moonshot  ", apiModelId: "  kimi-k3  " },
        },
      }),
    );
    await refreshCoreModelOverrides();
    expect(getCoreTierRouting("core-1")).toEqual({
      provider: "moonshot",
      apiModelId: "kimi-k3",
    });
  });

  it("treats a whitespace-only value as missing", async () => {
    vi.stubGlobal(
      "fetch",
      fetchOk({
        models: { "core-1": "a/b" },
        routing: { "core-1": { provider: "   ", apiModelId: "kimi-k3" } },
      }),
    );
    await refreshCoreModelOverrides();
    expect(getCoreTierRouting("core-1")).toBeUndefined();
  });
});

describe("getCoreModelsDevTargetForTier", () => {
  it("prefers the routing block, preserving the vendor's exact casing", () => {
    // THE CASING TRAP: the wire id is `minimax/minimax-m3` but the models.dev key is
    // `MiniMax-M3`, and that lookup is case-sensitive. Deriving the id by splitting
    // the wire id would miss the row and lose core-4's price AND its 1M window.
    setCoreModelOverrides({ "core-4": "minimax/minimax-m3" });
    setCoreModelRouting({
      "core-4": { provider: "minimax", apiModelId: "MiniMax-M3" },
    });
    expect(getCoreModelsDevTargetForTier("core-4")).toEqual({
      providerId: "minimax",
      modelId: "MiniMax-M3",
    });
  });

  it("falls back to splitting the wire id when there is no routing", () => {
    // Correct for the OpenRouter-era shape, where the prefix IS the provider.
    setCoreModelOverrides({ "core-3": "deepseek/deepseek-v4-pro" });
    expect(getCoreModelsDevTargetForTier("core-3")).toEqual({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
    });
  });

  it("lowercases only the provider segment in the fallback, never the model id", () => {
    setCoreModelOverrides({ "core-4": "MiniMax/MiniMax-M3" });
    expect(getCoreModelsDevTargetForTier("core-4")).toEqual({
      providerId: "minimax",
      modelId: "MiniMax-M3",
    });
  });

  it("returns undefined for a wire id with no vendor prefix", () => {
    setCoreModelOverrides({ "core-1": "bare-model-id" });
    expect(getCoreModelsDevTargetForTier("core-1")).toBeUndefined();
  });

  it("returns undefined for malformed prefixes", () => {
    setCoreModelOverrides({ "core-1": "/leading" });
    expect(getCoreModelsDevTargetForTier("core-1")).toBeUndefined();
    setCoreModelOverrides({ "core-2": "trailing/" });
    expect(getCoreModelsDevTargetForTier("core-2")).toBeUndefined();
  });

  it("returns undefined when the tier has no model at all", () => {
    expect(getCoreModelsDevTargetForTier("core-1")).toBeUndefined();
  });

  it("normalizes legacy tier ids", () => {
    setCoreModelRouting({
      "core-1": { provider: "moonshot", apiModelId: "kimi-k3" },
    });
    expect(getCoreModelsDevTargetForTier("compass-fast")).toEqual({
      providerId: "moonshot",
      modelId: "kimi-k3",
    });
  });
});

describe("lineup size is config-driven", () => {
  /**
   * There are four SLOTS but the lineup is whatever core-models.json maps. Running
   * three models used to leave a raw "core-4" entry in the picker that resolved to
   * nothing and threw at dispatch, so the tier count was effectively hardcoded.
   */
  it("lists only the configured tiers — a 3-model lineup shows 3", () => {
    setCoreModelOverrides({
      "core-1": "moonshotai/kimi-k3",
      "core-2": "zai/glm-5.2",
      "core-3": "deepseek/deepseek-v4-pro",
    });
    const catalog = buildAtlarixCoreTierCatalog();
    expect(catalog).toHaveLength(3);
    expect(catalog.map((e) => e.internalTierId)).toEqual([
      "core-1",
      "core-2",
      "core-3",
    ]);

    const models = getCompassSyntheticModels();
    expect(models).toHaveLength(3);
    // No placeholder leaked through as a display name.
    for (const m of models) {
      expect(m.displayName).not.toMatch(/^core-\d$/);
    }
  });

  it("derives the provider slug from the vendor segment, incl. zai", () => {
    setCoreModelOverrides({ "core-2": "zai/glm-5.2" });
    expect(buildAtlarixCoreTierCatalog()[0]!.providerSlug).toBe("zai");
  });

  it("supports a 2-model lineup with no code change", () => {
    setCoreModelOverrides({
      "core-1": "moonshotai/kimi-k3",
      "core-3": "deepseek/deepseek-v4-pro",
    });
    expect(buildAtlarixCoreTierCatalog()).toHaveLength(2);
    expect(getCompassSyntheticModels()).toHaveLength(2);
  });

  it("omits a slot whose id is blank rather than showing an empty row", () => {
    setCoreModelOverrides({ "core-1": "moonshotai/kimi-k3" });
    const catalog = buildAtlarixCoreTierCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]!.coreModelId).toBe("moonshotai/kimi-k3");
  });
});

describe("empty and parked slots", () => {
  /**
   * A slot with no model cannot be an empty string: GitHub Actions secrets refuse empty
   * values. So an unused slot carries a placeholder, and every layer has to read that as
   * EMPTY — otherwise "TBA" is dispatched to a provider as a model id.
   */
  it.each(["TBA", "tba", "TBD", "none", "N/A", "-", "null"])(
    "treats a hosted slot of %s as empty",
    async (placeholder) => {
      vi.stubGlobal(
        "fetch",
        fetchOk({
          models: {
            "core-1": placeholder,
            "core-2": "deepseek/deepseek-v4-pro",
          },
        }),
      );
      await refreshCoreModelOverrides();
      expect(getCoreModelIdForCoreTier("core-1")).toBeUndefined();
      expect(getCoreModelIdForCoreTier("core-2")).toBe(
        "deepseek/deepseek-v4-pro",
      );
      // And the parked slot must not reach the picker.
      expect(getCompassSyntheticModels().map((m) => m.apiName)).toEqual([
        "core-2",
      ]);
    },
  );

  it("treats a parked ENV slot as empty too", () => {
    process.env.ATLARIX_CORE_MODEL_1 = "TBA";
    process.env.ATLARIX_CORE_MODEL_2 = "deepseek/deepseek-v4-pro";
    expect(getCoreModelIdForCoreTier("core-1")).toBeUndefined();
    expect(getCoreModelIdForCoreTier("core-2")).toBe(
      "deepseek/deepseek-v4-pro",
    );
  });

  it("supports ZERO configured models without inventing rows", () => {
    // A lineup being rebuilt is a real state. Nothing should render, and callers get a
    // clear "nothing configured" answer rather than a broken row.
    expect(getCompassSyntheticModels()).toEqual([]);
    expect(buildAtlarixCoreTierCatalog()).toEqual([]);
    expect(getFirstConfiguredCoreTier()).toBeUndefined();
    expect(resolveConfiguredCoreTier("core-1")).toBeUndefined();
  });

  it("is empty when every hosted slot is parked", async () => {
    vi.stubGlobal(
      "fetch",
      fetchOk({
        models: { "core-1": "TBA", "core-2": "TBA", "core-3": "TBA" },
      }),
    );
    await refreshCoreModelOverrides();
    expect(getCompassSyntheticModels()).toEqual([]);
  });
});

describe("resolving a tier that is not in the lineup", () => {
  /**
   * Dropping a model from the lineup must not break users. Two paths assumed core-1
   * always existed: the BYOK-no-key rescue hardcoded it, and a selection persisted
   * before the lineup changed still names it. Both would have hard-failed the turn.
   */
  it("finds a configured tier even when the preferred slot is absent", () => {
    setCoreModelOverrides({
      "core-1": "z-ai/glm-5.2",
      "core-2": "deepseek/deepseek-v4-pro",
    });
    // core-3 is the preference and is unmapped here, so this falls through to slot
    // order — which is what keeps a partial lineup working.
    expect(getFirstConfiguredCoreTier()).toBe("core-1");
  });

  /**
   * The default is a PRODUCT decision, not slot order. **core-3 as of 2026-09-09**
   * (core-2 for the single day before that, core-1 by accident before THAT, because
   * `CORE_TIER_ORDER` was doing double duty as display order and preference order).
   *
   * An unopinionated caller gets the tier we most want a new user's first turn to run
   * on. Asserted against a THREE-slot lineup because that is the shipped shape, and
   * because a two-slot fixture cannot tell "prefers core-3" from "prefers the last
   * configured slot".
   */
  it("prefers core-3 over the lower slots when all three are configured", () => {
    setCoreModelOverrides({
      "core-1": "z-ai/glm-5.3",
      "core-2": "openai/gpt-5.6-terra",
      "core-3": "openai/gpt-6-astra",
    });
    expect(getFirstConfiguredCoreTier()).toBe("core-3");
  });

  it("still falls back in slot order when core-3 is unconfigured", () => {
    // The preference must not become a requirement — a lineup without core-3 has to
    // keep working rather than reporting "nothing configured".
    setCoreModelOverrides({
      "core-1": "z-ai/glm-5.3",
      "core-2": "openai/gpt-5.6-terra",
    });
    expect(getFirstConfiguredCoreTier()).toBe("core-1");
  });

  it("is undefined when nothing is configured, so callers can say so plainly", () => {
    expect(getFirstConfiguredCoreTier()).toBeUndefined();
  });

  it("passes a configured tier through untouched", () => {
    setCoreModelOverrides({ "core-3": "deepseek/deepseek-v4-pro" });
    expect(resolveConfiguredCoreTier("core-3")).toEqual({
      tier: "core-3",
      substituted: false,
    });
  });

  it("substitutes forward for a tier dropped from the lineup", () => {
    // A user who had Core 1 selected before Kimi was removed keeps working.
    setCoreModelOverrides({
      "core-2": "z-ai/glm-5.2",
      "core-3": "deepseek/deepseek-v4-pro",
    });
    expect(resolveConfiguredCoreTier("core-1")).toEqual({
      tier: "core-2",
      substituted: true,
    });
  });

  /**
   * Substitution must NOT use the default preference, and this is the test that says
   * why. `getFirstConfiguredCoreTier` prefers core-3 because a caller with no opinion
   * should get our best tier. A caller whose SAVED tier vanished is the opposite case:
   * they chose, their choice is gone, and promoting them to the top of the lineup is a
   * bill they never asked for — core-3 can cost several times core-1.
   *
   * So the two must disagree here, and asserting both in one test is what stops a
   * future tidy-up from collapsing them back into one order.
   */
  it("substitutes in SLOT order, not the default preference", () => {
    setCoreModelOverrides({
      "core-1": "z-ai/glm-5.3",
      "core-3": "openai/gpt-6-astra",
    });
    // The dropped middle slot falls back to the cheaper neighbour…
    expect(resolveConfiguredCoreTier("core-2")).toEqual({
      tier: "core-1",
      substituted: true,
    });
    // …while an unopinionated caller still gets the top tier.
    expect(getFirstConfiguredCoreTier()).toBe("core-3");
  });

  it("normalizes a legacy alias before substituting", () => {
    setCoreModelOverrides({ "core-3": "deepseek/deepseek-v4-pro" });
    // compass-fast -> core-1, which is unconfigured, so it falls forward to core-3.
    expect(resolveConfiguredCoreTier("compass-fast")).toEqual({
      tier: "core-3",
      substituted: true,
    });
  });

  it("returns undefined when there is nothing to substitute to", () => {
    expect(resolveConfiguredCoreTier("core-1")).toBeUndefined();
  });
});

describe("getCoreModelIdForCoreTier rename", () => {
  it("keeps the deprecated alias pointing at the same function", () => {
    // The old name is imported across tests and call sites; breaking it would be a
    // rename-only churn cost with no benefit.
    expect(getOpenRouterModelIdForCoreTier).toBe(getCoreModelIdForCoreTier);
  });

  it("still resolves the wire id under the new name", () => {
    setCoreModelOverrides({ "core-3": "deepseek/deepseek-v4-pro" });
    expect(getCoreModelIdForCoreTier("core-3")).toBe(
      "deepseek/deepseek-v4-pro",
    );
  });
});

/**
 * The tier a NEW INSTALL lands on.
 *
 * THE BUG THIS EXISTS TO PREVENT, because it already happened once: "the default
 * Core tier" was written down twice with nothing linking the two —
 * `DEFAULT_CORE_TIER_ORDER` here, and `DEFAULT_SETTINGS.selectedModel` over in
 * `main/settings.ts`. Moving the order to core-3 moved nothing a real user sees,
 * since its only production caller is the BYOK-rescue path, while settings quietly
 * kept every new install on core-1. The whole release read as shipped and the goal
 * was untouched.
 */
describe("the new-user default tier", () => {
  it("is Atlarix Auto — a slot id, never a model id", () => {
    // Owner decision 2026-09-23: new installs start on Auto, which is free for
    // an account with nothing to pay with and routed per step otherwise.
    expect(DEFAULT_NEW_USER_CORE_TIER).toBe("core-auto");
    expect(DEFAULT_NEW_USER_CORE_TIER).not.toContain("/");
  });

  it("the paid fallback is a SLOT id, never a model id", () => {
    // Owner constraint, and the reason the lineup can change without an app
    // update: a model id here would pin users to one model forever, and would
    // stop resolving the day that model left the lineup.
    expect(CORE_TIER_ORDER).toContain(DEFAULT_PAID_CORE_TIER);
    expect(DEFAULT_PAID_CORE_TIER).toMatch(/^core-\d+$/);
  });

  it("is the same tier an unopinionated caller would be given", () => {
    // The coupling itself. If these two ever disagree again, the product decision
    // has silently split in half.
    setCoreModelOverrides({
      "core-1": "z-ai/glm-5.3",
      "core-2": "openai/gpt-5.5-terra",
      "core-3": "openai/gpt-6-astra",
    });
    expect(getFirstConfiguredCoreTier()).toBe(DEFAULT_PAID_CORE_TIER);
  });

  it("survives its slot being dropped from the lineup", () => {
    // A new install must not be stranded by a config change it never saw. The
    // constant still names core-3; resolution falls forward in slot order.
    setCoreModelOverrides({ "core-1": "z-ai/glm-5.3" });
    const resolved = resolveConfiguredCoreTier(DEFAULT_PAID_CORE_TIER);
    expect(resolved).toEqual({ tier: "core-1", substituted: true });
  });
});
