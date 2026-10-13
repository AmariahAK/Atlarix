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
