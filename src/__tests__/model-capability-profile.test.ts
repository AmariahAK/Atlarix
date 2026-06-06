/**
 * v12 2.1 — capability catalog + heuristic fallback + trim/simplify helpers.
 */

import { describe, expect, it } from "vitest";
import {
  getCapabilityProfile,
  trimToolsForCapability,
  simplifyToolParametersForProfile,
  providerSupportsToolMedia,
} from "@/lib/routing/model-capability-profile";

describe("getCapabilityProfile", () => {
  it.each([
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "gpt-4o-mini", // small variant of a strong family stays FULL
    "gpt-5",
    "o3-mini",
    "gemini-2.5-flash",
    "deepseek-chat",
    "grok-4",
    "qwen2.5-72b-instruct",
  ])("%s gets the full surface", (name) => {
    const p = getCapabilityProfile({ name });
    expect(p.maxTools).toBeNull();
    expect(p.schemaComplexity).toBe("full");
  });

  it.each([
    "llama3:8b",
    "qwen2.5-7b-instruct",
    "phi-3 3.8b",
    "mystery-model-1.5b",
  ])("%s (small param count, unknown family) is trimmed", (name) => {
    const p = getCapabilityProfile({ name });
    expect(p.maxTools).toBe(12);
    expect(p.schemaComplexity).toBe("simplified");
  });

  it("small-words hint only trims on LOCAL providers", () => {
    expect(
      getCapabilityProfile({
        name: "some-mini-model",
        builtinProviderId: "ollama",
      }).maxTools,
    ).toBe(12);
    // Unknown cloud model with 'mini' in the name: default FULL (never
    // degrade what we can't classify).
    expect(
      getCapabilityProfile({ name: "some-mini-model" }).maxTools,
    ).toBeNull();
  });

  it("unknown models default to the full surface", () => {
    expect(
      getCapabilityProfile({ name: "totally-unknown-xl" }).maxTools,
    ).toBeNull();
  });

  it("tool media follows the provider gate", () => {
    expect(
      getCapabilityProfile({
        name: "claude-sonnet-4-5",
        builtinProviderId: "anthropic",
      }).supportsToolMedia,
    ).toBe(true);
    expect(
      getCapabilityProfile({
        name: "claude-sonnet-4-5",
        builtinProviderId: "compass",
      }).supportsToolMedia,
    ).toBe(false);
    expect(providerSupportsToolMedia("google")).toBe(true);
    expect(providerSupportsToolMedia(undefined)).toBe(false);
  });
});

describe("trimToolsForCapability", () => {
  const tool = (name: string, cost: number, core = false) => ({
    name,
    cost,
    core,
  });
  const isCore = (t: { core: boolean }) => t.core;

  it("keeps core tools first, then cheapest, preserving input order", () => {
    const tools = [
      tool("z-expensive", 9),
      tool("core-late", 5, true),
      tool("cheap", 1),
      tool("mid", 3),
      tool("core-early", 8, true),
    ];
    const out = trimToolsForCapability(
      tools,
      { maxTools: 3, schemaComplexity: "simplified", supportsToolMedia: false },
      isCore,
    );
    // Keep-set: both cores + the cheapest non-core; output preserves input order.
    expect(out.map((t) => t.name)).toEqual([
      "core-late",
      "cheap",
      "core-early",
    ]);
  });

  it("no-op when under the cap or uncapped", () => {
    const tools = [tool("a", 1), tool("b", 2)];
    expect(
      trimToolsForCapability(
        tools,
        { maxTools: null, schemaComplexity: "full", supportsToolMedia: false },
        isCore,
      ),
    ).toBe(tools);
    expect(
      trimToolsForCapability(
        tools,
        {
          maxTools: 5,
          schemaComplexity: "simplified",
          supportsToolMedia: false,
        },
        isCore,
      ),
    ).toBe(tools);
  });
});

describe("simplifyToolParametersForProfile", () => {
  const simplified = {
    maxTools: 12,
    schemaComplexity: "simplified" as const,
    supportsToolMedia: false,
  };
  const full = {
    maxTools: null,
    schemaComplexity: "full" as const,
    supportsToolMedia: false,
  };

  const schema = {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      opt1: { type: "string" },
      opt2: { type: "string" },
      opt3: { type: "string" },
      opt4: { type: "string" },
      opt5: { type: "string" },
    },
    required: ["path", "content"],
  };

  it("keeps required params + the first few optionals", () => {
    const out = simplifyToolParametersForProfile(
      schema,
      simplified,
    ) as typeof schema;
    expect(Object.keys(out.properties)).toEqual([
      "path",
      "content",
      "opt1",
      "opt2",
      "opt3",
    ]);
    expect(out.required).toEqual(["path", "content"]);
  });

  it("full profile passes through untouched", () => {
    expect(simplifyToolParametersForProfile(schema, full)).toBe(schema);
  });

  it("non-object schemas pass through", () => {
    expect(
      simplifyToolParametersForProfile(undefined, simplified),
    ).toBeUndefined();
    const arr = { type: "array" };
    expect(simplifyToolParametersForProfile(arr, simplified)).toBe(arr);
  });
});
