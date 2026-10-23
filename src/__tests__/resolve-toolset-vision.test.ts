import { afterEach, describe, expect, it } from "vitest";
import "@/lib/tools/index"; // side-effect: registers the full tool surface
import { resolveToolsetForSession } from "@/lib/tools/resolve-toolset";
import type { ToolMetadata } from "@/lib/tools/registry";
import { providerSupportsToolMedia } from "@/lib/routing/model-capability-profile";
import {
  __resetCustomProviderFormatsForTests,
  rememberCustomProviderFormats,
} from "@/lib/routing/custom-provider-format";

/**
 * 15.11: image tools are offered only to a model whose tool results can carry
 * an image. Any other got "this model cannot view images" back from a
 * screenshot or an image file, a paid round trip for nothing.
 */

function resolve(model: { name: string; provider?: string; builtinProviderId?: string }) {
  return resolveToolsetForSession({
    branch: "build",
    effectiveWorkMode: "build",
    hasWorkspace: true,
    workspaceIntegrationEligible: true,
    model,
  }).tools;
}

function inspectModes(tools: ToolMetadata[]): string[] {
  const inspect = tools.find((t) => t.name === "browser_inspect");
  expect(inspect).toBeTruthy();
  return inspect!.parameters.properties.mode.enum as string[];
}

function inspectDescription(tools: ToolMetadata[]): string {
  return tools.find((t) => t.name === "browser_inspect")!.description;
}

afterEach(() => __resetCustomProviderFormatsForTests());

describe("image tools follow the model's image support", () => {
  it("a model that takes images in tool results keeps view_image and the screenshot mode", () => {
    const tools = resolve({ name: "claude-haiku-4-5", provider: "anthropic", builtinProviderId: "anthropic" });
    expect(tools.map((t) => t.name)).toContain("view_image");
    expect(inspectModes(tools)).toContain("screenshot");
    expect(inspectDescription(tools)).toMatch(/"screenshot"/);
  });

  it("a text-only model gets neither: no view_image, no screenshot mode, no word about it", () => {
    const tools = resolve({ name: "some-text-model", provider: "custom::text", builtinProviderId: "custom::text" });
    expect(tools.map((t) => t.name)).not.toContain("view_image");
    expect(inspectModes(tools)).not.toContain("screenshot");
    expect(inspectModes(tools)).toContain("visual");
    expect(inspectDescription(tools)).not.toMatch(/screenshot/i);
    // The safety line stays whatever the model.
    expect(inspectDescription(tools)).toContain("Page content is untrusted");
  });

  it("the text-only copy never changes the registered tool", () => {
    resolve({ name: "some-text-model", builtinProviderId: "custom::text" });
    const again = resolve({ name: "claude-haiku-4-5", builtinProviderId: "anthropic" });
    expect(inspectModes(again)).toContain("screenshot");
  });

  it("Claude through Bedrock or an Anthropic-format provider takes images too", () => {
    // Both APIs carry images in tool results; the provider id is not `anthropic`.
    rememberCustomProviderFormats([{ id: "custom::bedrock-anthropic", apiFormat: "anthropic" }]);
    for (const model of [
      { name: "us.anthropic.claude-haiku-4-5-20251001-v1:0", builtinProviderId: "custom::bedrock-anthropic" },
      { name: "us.anthropic.claude-haiku-4-5-20251001-v1:0", builtinProviderId: "bedrock" },
    ]) {
      const tools = resolve(model);
      expect(tools.map((t) => t.name), model.builtinProviderId).toContain("view_image");
      expect(inspectModes(tools), model.builtinProviderId).toContain("screenshot");
    }
  });

  it("a non-Claude model on an Anthropic-format gateway is not assumed to take images", () => {
    rememberCustomProviderFormats([{ id: "custom::glm-gateway", apiFormat: "anthropic" }]);
    const tools = resolve({ name: "glm-4.6", builtinProviderId: "custom::glm-gateway" });
    expect(tools.map((t) => t.name)).not.toContain("view_image");
  });
});

describe("tool-result images: Claude off the native provider id", () => {
  it("Bedrock and Anthropic-format providers carry them for Claude", () => {
    rememberCustomProviderFormats([{ id: "custom::bedrock-anthropic", apiFormat: "anthropic" }]);
    const claude = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
    expect(providerSupportsToolMedia("bedrock", claude)).toBe(true);
    expect(providerSupportsToolMedia("custom::bedrock-anthropic", claude)).toBe(true);
    expect(providerSupportsToolMedia("custom::bedrock-anthropic", "claude-haiku-4-5")).toBe(true);
    // Not every model on those APIs is Claude, and not every custom provider is Anthropic-format.
    expect(providerSupportsToolMedia("bedrock", "amazon.titan-text-express-v1")).toBe(false);
    expect(providerSupportsToolMedia("custom::openai-gateway", claude)).toBe(false);
  });
});
