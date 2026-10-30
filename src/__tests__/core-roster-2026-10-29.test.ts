/**
 * The Core roster (owner, 2026-10-29, renumbered 2026-10-30): Auto, then slots
 * 1–6 = Terra, Sonnet, Sol, Opus, Astra, Fable, then Zenith. A slot the lineup
 * stops mapping moves its chats to Atlarix Auto, never to another paid slot.
 * Free accounts see "Free" on Auto and "Credit" on every paid row; nobody else
 * sees a tag.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetCoreModelOverridesForTests,
  setCoreAuto,
  setCoreModelOverrides,
  setCoreZenith,
} from "@/ipc/shared/core-model-override-store";
import {
  CORE_TIER_AUTO,
  CORE_TIER_ZENITH,
  getCompassSyntheticModels,
  getCoreModelIdForCoreTier,
  isCoreRouterTier,
  isCoreTierFromNewerBuild,
  resolveConfiguredCoreTier,
} from "@/ipc/shared/compass_constants";
import { parseCoreZenith } from "@/lib/routing/core-model-overrides";
import { modelGroups } from "@/cli/acp/agent";
import { CORE_CREDIT_DESCRIPTION } from "@/shared/billing_copy";

const LINEUP = {
  "core-1": "openai/gpt-6.1-terra",
  "core-2": "anthropic/claude-sonnet-5-5",
  "core-3": "openai/gpt-6.1-sol",
  "core-4": "anthropic/claude-opus-5-5",
  "core-5": "openai/gpt-6-astra",
  "core-6": "anthropic/claude-fable-5-1",
};

beforeEach(() => {
  __resetCoreModelOverridesForTests();
  setCoreModelOverrides(LINEUP);
  setCoreAuto({ id: "atlarix/auto", label: "Atlarix Auto" });
  setCoreZenith({ id: "atlarix/zenith", label: "Atlarix Zenith" });
});

describe("the picker shows the owner's roster, in order", () => {
  it("Auto, Terra, Sonnet, Sol, Opus, Astra, Fable, Zenith: slot order", () => {
    const rows = getCompassSyntheticModels().map((m) => m.apiName);
    expect(rows).toEqual(["core-auto", "core-1", "core-2", "core-3", "core-4", "core-5", "core-6", "core-zenith"]);
  });

  it("labels: Auto and Zenith described, Core rows not, never 'for every step'", () => {
    const byId = Object.fromEntries(getCompassSyntheticModels().map((m) => [m.apiName, m]));
    expect(byId["core-auto"].description).toBe("Most cost effective for capable intelligence");
    expect(byId["core-zenith"].description).toBe("Frontier intelligence at a higher cost");
    expect(byId["core-zenith"].displayName).toBe("Atlarix Zenith");
    for (const id of ["core-1", "core-2", "core-3", "core-4", "core-5", "core-6"]) expect(byId[id].description).toBe("");
    for (const m of getCompassSyntheticModels()) expect(m.description ?? "").not.toMatch(/every step/i);
  });

  it("Zenith is absent when the hosted config does not offer it", () => {
    setCoreZenith(null);
    expect(getCompassSyntheticModels().map((m) => m.apiName)).not.toContain("core-zenith");
    expect(resolveConfiguredCoreTier(CORE_TIER_ZENITH)).toBeUndefined();
  });
});

describe("a pinned chat on a slot the lineup stops mapping moves to Atlarix Auto", () => {
  it("an unmapped paid slot goes to Auto (15.11.1 went to the next paid slot)", () => {
    setCoreModelOverrides({ "core-1": LINEUP["core-1"] });
    expect(resolveConfiguredCoreTier("core-4")).toEqual({ tier: CORE_TIER_AUTO, substituted: true });
  });

  it("with no Auto offered, it refuses rather than landing on a paid one", () => {
    setCoreModelOverrides({ "core-1": LINEUP["core-1"] });
    setCoreAuto(null);
    expect(resolveConfiguredCoreTier("core-4")).toBeUndefined();
  });

  it("live slots, Auto and Zenith resolve to themselves", () => {
    for (const id of ["core-1", "core-2", "core-3", "core-4", "core-5", "core-6", CORE_TIER_AUTO, CORE_TIER_ZENITH]) {
      expect(resolveConfiguredCoreTier(id)).toEqual({ tier: id, substituted: false });
    }
    expect(getCoreModelIdForCoreTier(CORE_TIER_ZENITH)).toBe("atlarix/zenith");
    expect(getCoreModelIdForCoreTier("core-6")).toBe("anthropic/claude-fable-5-1");
  });

  it("core-6 is this build's own slot; core-7 is from a newer build", () => {
    expect(isCoreTierFromNewerBuild("core-6")).toBe(false);
    expect(isCoreTierFromNewerBuild("core-7")).toBe(true);
  });

  it("Auto and Zenith are the router tiers (no effort control)", () => {
    expect(isCoreRouterTier(CORE_TIER_AUTO)).toBe(true);
    expect(isCoreRouterTier(CORE_TIER_ZENITH)).toBe(true);
    expect(isCoreRouterTier("core-1")).toBe(false);
  });
});

describe("the hosted config's new keys", () => {
  it("reads `auto.zenith`", () => {
    expect(
      parseCoreZenith({
        auto: { id: "atlarix/auto", zenith: { id: "atlarix/zenith", label: "Atlarix Zenith", levels: { top: [{ provider: "anthropic", apiModelId: "claude-opus-5-5" }] } } },
      }),
    ).toEqual({ id: "atlarix/zenith", label: "Atlarix Zenith", models: [{ providerId: "anthropic", modelId: "claude-opus-5-5" }] });
    expect(parseCoreZenith({ auto: { id: "atlarix/auto" } })).toBeNull();
  });
});

describe("ACP editors see the tag as text", () => {
  it("Auto 'Free', a paid row 'Uses credit', a paying account neither", () => {
    const g = modelGroups([
      { provider: "compass", name: "core-auto", label: "Atlarix Auto", detail: "Most cost effective for capable intelligence", free: true },
      { provider: "compass", name: "core-1", label: "GPT-6.1 Terra", detail: "1M context", credit: true },
      { provider: "compass", name: "core-2", label: "Claude Sonnet 5.5", detail: "1M context" },
    ]);
    const d = Object.fromEntries(g.flatMap((x) => x.options).map((o) => [o.value, o.description]));
    expect(d["compass/core-auto"]).toBe("Free · Most cost effective for capable intelligence");
    expect(d["compass/core-1"]).toBe(`${CORE_CREDIT_DESCRIPTION} · 1M context`);
    expect(d["compass/core-2"]).toBe("1M context");
  });
});
