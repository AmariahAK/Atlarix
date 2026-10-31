/**
 * Bedrock model listing (0i): models.dev gives one bare on-demand id and one
 * inference profile per region for each Claude model, all with the same family.
 * The bare `anthropic.*` id is refused by Bedrock for every current Claude
 * model, and only the configured region's profile (plus `global.`) can be
 * invoked — so the picker must only offer those.
 */

import { describe, expect, it } from "vitest";
import {
  bedrockInferencePrefixForRegion,
  filterBedrockCatalogModels,
} from "@/lib/bedrock-catalog";

const model = (name: string) => ({ name, tool_call: true });

describe("bedrockInferencePrefixForRegion", () => {
  it("maps a region to its inference-profile prefix", () => {
    expect(bedrockInferencePrefixForRegion("us-east-1")).toBe("us.");
    expect(bedrockInferencePrefixForRegion("eu-west-1")).toBe("eu.");
    expect(bedrockInferencePrefixForRegion("ap-southeast-1")).toBe("apac.");
  });

  it("returns nothing for a region with no regional profile", () => {
    expect(bedrockInferencePrefixForRegion("ca-central-1")).toBe("");
    expect(bedrockInferencePrefixForRegion("")).toBe("");
  });
});

describe("filterBedrockCatalogModels", () => {
  // The five-way duplication the owner hit: bare, us, eu, au, global.
  const OPUS = {
    "anthropic.claude-opus-4-6-v1": model("Claude Opus 4.6"),
    "us.anthropic.claude-opus-4-6-v1": model("Claude Opus 4.6 (US)"),
    "eu.anthropic.claude-opus-4-6-v1": model("Claude Opus 4.6 (EU)"),
    "au.anthropic.claude-opus-4-6-v1": model("Claude Opus 4.6 (AU)"),
    "global.anthropic.claude-opus-4-6-v1": model("Claude Opus 4.6 (Global)"),
  };

  it("keeps the configured region's profile and global, drops the rest", () => {
    const out = filterBedrockCatalogModels(OPUS, "us-east-1");
    expect(Object.keys(out).sort()).toEqual([
      "global.anthropic.claude-opus-4-6-v1",
      "us.anthropic.claude-opus-4-6-v1",
    ]);
  });

  it("drops the bare anthropic.* id, which Bedrock refuses", () => {
    const out = filterBedrockCatalogModels(OPUS, "us-east-1");
    expect(Object.keys(out)).not.toContain("anthropic.claude-opus-4-6-v1");
  });

  it("keeps only global when the region has no regional profile", () => {
    const out = filterBedrockCatalogModels(OPUS, "ca-central-1");
    expect(Object.keys(out)).toEqual(["global.anthropic.claude-opus-4-6-v1"]);
  });

  it("keeps non-Anthropic bare ids (on-demand still works for them)", () => {
    const catalog = {
      "meta.llama3-8b-instruct-v1:0": model("Llama 3 8B"),
      "amazon.nova-micro-v1:0": model("Nova Micro"),
      "us.amazon.nova-micro-v1:0": model("Nova Micro (US)"),
    };
    const out = filterBedrockCatalogModels(catalog, "us-east-1");
    expect(Object.keys(out).sort()).toEqual([
      "amazon.nova-micro-v1:0",
      "meta.llama3-8b-instruct-v1:0",
      "us.amazon.nova-micro-v1:0",
    ]);
  });

  it("distinguishes two survivors that share a catalog name", () => {
    const catalog = {
      "us.anthropic.claude-sonnet-5-5": model("Claude Sonnet 5.5"),
      "global.anthropic.claude-sonnet-5-5": model("Claude Sonnet 5.5"),
    };
    const out = filterBedrockCatalogModels(catalog, "us-east-1");
    const names = Object.values(out).map((m) => m.name).sort();
    expect(names).toEqual(["Claude Sonnet 5.5 (global)", "Claude Sonnet 5.5 (us)"]);
  });

  it("leaves a lone survivor's already-suffixed name alone", () => {
    const out = filterBedrockCatalogModels(OPUS, "us-east-1");
    expect(out["us.anthropic.claude-opus-4-6-v1"]!.name).toBe("Claude Opus 4.6 (US)");
    expect(out["global.anthropic.claude-opus-4-6-v1"]!.name).toBe("Claude Opus 4.6 (Global)");
  });
});
