import { describe, expect, it } from "vitest";
import {
  normalizeAskUserPayload,
  normalizeAskUserQuestions,
} from "@/lib/tools/ask_user_options";

describe("ask_user normalizer — model-shape robustness", () => {
  it("coerces object options ({label}) to strings instead of [object Object]", () => {
    const norm = normalizeAskUserPayload({
      question: "Pick a language",
      options: [
        { label: "TypeScript", description: "typed" },
        { label: "JavaScript", description: "plain" },
      ],
    });
    expect(norm.question).toBe("Pick a language");
    expect(norm.options).toEqual(["TypeScript", "JavaScript"]);
  });

  it("does not collapse distinct object options via Set-dedup", () => {
    // Regression: String({…}) → "[object Object]" deduped all options to one.
    const norm = normalizeAskUserPayload({
      question: "Choose",
      options: [{ label: "A" }, { label: "B" }, { label: "C" }],
    });
    expect(norm.options).toEqual(["A", "B", "C"]);
  });

  it("extracts option text from alternate object keys (value/title/name)", () => {
    const norm = normalizeAskUserPayload({
      question: "Choose",
      options: [{ value: "one" }, { title: "two" }, { name: "three" }],
    });
    expect(norm.options).toEqual(["one", "two", "three"]);
  });

  it("resolves the question from alias fields (prompt/header/text)", () => {
    expect(normalizeAskUserPayload({ prompt: "via prompt" }).question).toBe(
      "via prompt",
    );
    expect(normalizeAskUserPayload({ header: "via header" }).question).toBe(
      "via header",
    );
    expect(normalizeAskUserPayload({ text: "via text" }).question).toBe(
      "via text",
    );
  });

  it("synthesizes a title when options exist but the question is empty (never leaks options as the title)", () => {
    const norm = normalizeAskUserPayload({
      options: [{ label: "Red" }, { label: "Blue" }],
    });
    expect(norm.question).toBe("Select an option:");
    expect(norm.options).toEqual(["Red", "Blue"]);
  });

  it("handles the real minimax batch shape (questions[] with object options)", () => {
    const out = normalizeAskUserQuestions({
      questions: [
        {
          question: "How should the update endpoint be scoped?",
          options: [
            { label: "Status only", description: "..." },
            { label: "All fields", description: "..." },
          ],
        },
        {
          // alias field + object options
          prompt: "Validate status transitions?",
          options: [{ label: "State machine" }, { label: "Any-to-any" }],
        },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      question: "How should the update endpoint be scoped?",
      options: ["Status only", "All fields"],
    });
    expect(out[1]).toEqual({
      question: "Validate status transitions?",
      options: ["State machine", "Any-to-any"],
    });
  });

  it("still supports the legacy single question + string options", () => {
    const out = normalizeAskUserQuestions({
      question: "Tabs or spaces?",
      options: ["Tabs", "Spaces"],
    });
    expect(out).toEqual([
      { question: "Tabs or spaces?", options: ["Tabs", "Spaces"] },
    ]);
  });
});
