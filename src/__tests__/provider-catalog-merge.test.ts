/**
 * The catalog-as-floor invariant.
 *
 * Regression suite for a bug that shipped four separate times under the old
 * shape (native fetch wins; catalog consulted ONLY if native threw). Anthropic's
 * `/models` paginates at 20, Google's at 50, Cohere's at 20 — each returned a
 * TRUNCATED list at HTTP 200. Nothing threw, so the catalog fallback never
 * fired, and the picker silently lost models while the correct answer sat in
 * memory. Bedrock listed zero for the mirror reason.
 *
 * The property that kills the whole class: a native response can only ADD
 * models or REFINE fields. It can never shrink the list below the catalog.
 */

import { describe, expect, it } from "vitest";
import type { LanguageModel } from "@/ipc/ipc_types";
import { mergeByApiName } from "@/lib/models/merge-provider-models";

/** LanguageModel is a cloud|custom union; these fixtures are all cloud. */
const asCloud = (m: LanguageModel) => {
  if (m.type !== "cloud")
    throw new Error(`expected a cloud model, got ${m.type}`);
  return m;
};

const cloud = (
  apiName: string,
  extra: Partial<LanguageModel> = {},
): LanguageModel =>
  ({
    apiName,
    displayName: apiName,
    description: "",
    type: "cloud",
    ...extra,
  }) as LanguageModel;

/** Stand-in for a provider family the catalog knows in full. */
const CATALOG = [
  cloud("claude-opus-4-8", {
    displayName: "Claude Opus 4.8",
    contextWindow: 200_000,
  }),
  cloud("claude-sonnet-5", {
    displayName: "Claude Sonnet 5",
    contextWindow: 200_000,
  }),
  cloud("claude-haiku-4-5", {
    displayName: "Claude Haiku 4.5",
    contextWindow: 200_000,
  }),
];

describe("native responses can never shrink the list", () => {
  it("keeps the full catalog when native truncates (the limit=20 bug)", () => {
    // The exact shape of the Anthropic/Google/Cohere failures: a SUCCESSFUL
    // response carrying only the first page.
    const truncated = [cloud("claude-opus-4-8")];
    const merged = mergeByApiName(CATALOG, truncated);
    expect(merged).toHaveLength(3);
    expect(merged.map((m) => m.apiName).sort()).toEqual(
      CATALOG.map((m) => m.apiName).sort(),
    );
  });

  it("keeps the full catalog when native returns nothing at all", () => {
    // A fetcher that 4xx'd and swallowed it, or a provider with no fetcher.
    expect(mergeByApiName(CATALOG, [])).toHaveLength(3);
  });

  it("never drops a catalog model that native omits", () => {
    const merged = mergeByApiName(CATALOG, [cloud("claude-sonnet-5")]);
    for (const m of CATALOG) {
      expect(merged.some((x) => x.apiName === m.apiName)).toBe(true);
    }
  });
});

describe("native adds and refines", () => {
  it("appends models the catalog has never heard of (day-one launches)", () => {
    const merged = mergeByApiName(CATALOG, [cloud("claude-opus-5-brand-new")]);
    expect(merged).toHaveLength(4);
    expect(merged.some((m) => m.apiName === "claude-opus-5-brand-new")).toBe(
      true,
    );
  });

  it("lets native fields win on conflict (live OpenRouter pricing)", () => {
    const catalog = [
      cloud("x/y", { cost: { input: 1, output: 2 }, contextWindow: 100 }),
    ];
    const native = [
      cloud("x/y", { cost: { input: 3, output: 4 }, contextWindow: 900 }),
    ];
    const m = asCloud(mergeByApiName(catalog, native)[0]);
    expect(m.cost).toEqual({ input: 3, output: 4 });
    expect(m.contextWindow).toBe(900);
  });

  it("does NOT let an undefined native field clobber a real catalog value", () => {
    // A plain object spread would overwrite cost/contextWindow with undefined
    // here — which is how a native fetcher that reports no pricing used to blank
    // out the catalog's. That's why the overlay drops undefined keys.
    const catalog = [
      cloud("m", { cost: { input: 1, output: 2 }, contextWindow: 128_000 }),
    ];
    const native = [
      {
        apiName: "m",
        displayName: "m",
        description: "",
        type: "cloud",
      } as LanguageModel,
    ];
    const m = asCloud(mergeByApiName(catalog, native)[0]);
    expect(m.cost).toEqual({ input: 1, output: 2 });
    expect(m.contextWindow).toBe(128_000);
  });

  it("preserves a deliberate supportsToolChoice: false (Perplexity Sonar)", () => {
    const catalog = [cloud("sonar-pro", { supportsToolChoice: true })];
    const native = [cloud("sonar-pro", { supportsToolChoice: false })];
    expect(asCloud(mergeByApiName(catalog, native)[0]).supportsToolChoice).toBe(
      false,
    );
  });
});

describe("edge cases", () => {
  it("returns native alone when the provider has NO catalog rows (elastic)", () => {
    // Elastic lists Kibana agents from a user's self-hosted instance, not
    // models — it is genuinely absent from models.dev, so the empty floor is
    // correct and native must survive it untouched.
    const agents = [cloud("agent-1"), cloud("agent-2")];
    expect(mergeByApiName([], agents)).toEqual(agents);
  });

  it("returns the catalog alone when there is no native fetcher", () => {
    expect(mergeByApiName(CATALOG, [])).toEqual(CATALOG);
  });

  it("de-duplicates by apiName rather than listing a model twice", () => {
    const merged = mergeByApiName(CATALOG, CATALOG);
    expect(merged).toHaveLength(3);
  });

  it("sorts the merged list by context window desc, then name", () => {
    // Only when an actual merge happens: with no native rows the catalog is
    // returned untouched, since getModelsDevCatalogRows already sorted it and a
    // re-sort would be pure work.
    const merged = mergeByApiName(
      [cloud("small", { contextWindow: 8_000 })],
      [cloud("big", { contextWindow: 900_000 })],
    );
    expect(merged.map((m) => m.apiName)).toEqual(["big", "small"]);
  });
});
