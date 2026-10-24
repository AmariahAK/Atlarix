/**
 * QA (app) #26: a custom provider's model chosen by id read
 * "No Such Model Xyz (custom::qa-ai49-bad)" in the composer — the provider's
 * internal id — instead of the name it was added with.
 */
import { describe, it, expect } from "vitest";
import { resolveModelDisplayLabel } from "@/lib/resolve-model-display-label";

describe("a custom provider's model label", () => {
  it("names the provider as it was added", () => {
    expect(
      resolveModelDisplayLabel(
        { provider: "custom::qa-bad" as never, name: "no-such-model-xyz" },
        { modelsByProviders: {}, providerName: "QA No Such Model" },
      ),
    ).toBe("No Such Model Xyz (QA No Such Model)");
  });
});

describe("an endpoint of your own (the CLI's, atlarix-cli-dev-<hash>)", () => {
  const model = { provider: "atlarix-cli-dev-ee0d96d8" as never, name: "us.anthropic.claude-haiku-4-5-20251001-v1:0" };
  const anthropic = [{ apiName: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", type: "cloud" }];

  it("never shows its internal id, and names the model as the catalog does (15.11.1 QA)", () => {
    const label = resolveModelDisplayLabel(model, {
      modelsByProviders: {
        // Its own list names the model by its raw id (seeded before it was named).
        "atlarix-cli-dev-ee0d96d8": [{ apiName: model.name, displayName: model.name, type: "custom" }] as never,
        anthropic: anthropic as never,
      },
      providerName: "Your endpoint (bedrock-runtime.us-east-1.amazonaws.com)",
      customProvider: true,
    });
    expect(label).toBe("Claude Haiku 4.5 (Your endpoint (bedrock-runtime.us-east-1.amazonaws.com))");
    expect(label).not.toContain("atlarix-cli-dev");
  });

  it("with no name for the endpoint (not listed in this app): the model alone", () => {
    // Not even known as custom here: its id says it is a CLI endpoint.
    const label = resolveModelDisplayLabel(model, { modelsByProviders: { anthropic: anthropic as never } });
    expect(label).toBe("Claude Haiku 4.5");
  });

  it("its own list's real name wins", () => {
    const label = resolveModelDisplayLabel(model, {
      modelsByProviders: { "atlarix-cli-dev-ee0d96d8": [{ apiName: model.name, displayName: "Haiku (mine)", type: "custom" }] as never },
      customProvider: true,
    });
    expect(label).toBe("Haiku (mine)");
  });
});
