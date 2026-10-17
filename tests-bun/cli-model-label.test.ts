/** The header's model name at startup comes from cli-state, never from building the model list. */
import { describe, expect, it } from "bun:test";
import { savedModelLabel } from "../src/cli/agent/models";

describe("savedModelLabel", () => {
  const model = { provider: "openai", name: "gpt-6-luna" };
  it("is the remembered label of the chosen model", () => {
    expect(savedModelLabel({ recent: [], favorites: [], model, modelLabel: { ...model, label: "GPT-6 Luna" } })).toBe("GPT-6 Luna");
  });
  it("is the plain name when the label was saved for another model (chosen in an editor)", () => {
    expect(savedModelLabel({ recent: [], favorites: [], model, modelLabel: { provider: "openai", name: "gpt-6-sol", label: "GPT-6 Sol" } })).toBe("gpt-6-luna");
  });
  it("is nothing without a chosen model (the app's model is shown instead)", () => {
    expect(savedModelLabel({ recent: [], favorites: [] })).toBeUndefined();
  });
});
