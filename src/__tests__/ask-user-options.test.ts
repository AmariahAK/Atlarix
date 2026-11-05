import { describe, expect, it } from "vitest";
import {
  askUserOptionLabel,
  combineAskUserAnswers,
  joinAskUserPicks,
  normalizeAskUserPayload,
  normalizeAskUserQuestions,
  readAskUserQuestions,
  toAskUserWire,
} from "@/lib/tools/ask_user_options";

describe("ask_user normalizer — model-shape robustness", () => {
  it("keeps object options ({label, description}) instead of [object Object]", () => {
    const norm = normalizeAskUserPayload({
      question: "Pick a language",
      options: [
        { label: "TypeScript", description: "typed" },
        { label: "JavaScript", description: "plain" },
      ],
    });
    expect(norm.question).toBe("Pick a language");
    expect(norm.options).toEqual([
      { label: "TypeScript", description: "typed" },
      { label: "JavaScript", description: "plain" },
    ]);
  });

  it("does not collapse distinct object options via Set-dedup", () => {
    // Regression: String({…}) → "[object Object]" deduped all options to one.
    const norm = normalizeAskUserPayload({
      question: "Choose",
      options: [{ label: "A" }, { label: "B" }, { label: "C" }],
    });
    expect(norm.options).toEqual([{ label: "A" }, { label: "B" }, { label: "C" }]);
  });

  it("extracts option text from alternate object keys (value/title/name)", () => {
    const norm = normalizeAskUserPayload({
      question: "Choose",
      options: [{ value: "one" }, { title: "two" }, { name: "three" }],
    });
    expect(norm.options).toEqual([{ label: "one" }, { label: "two" }, { label: "three" }]);
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
    expect(norm.options).toEqual([{ label: "Red" }, { label: "Blue" }]);
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
      options: [
        { label: "Status only", description: "..." },
        { label: "All fields", description: "..." },
      ],
    });
    expect(out[1]).toEqual({
      question: "Validate status transitions?",
      options: [{ label: "State machine" }, { label: "Any-to-any" }],
    });
  });

  it("still supports the legacy single question + string options", () => {
    const out = normalizeAskUserQuestions({
      question: "Tabs or spaces?",
      options: ["Tabs", "Spaces"],
    });
    expect(out).toEqual([
      { question: "Tabs or spaces?", options: [{ label: "Tabs" }, { label: "Spaces" }] },
    ]);
  });
});

describe("ask_user like Claude Code's: header, multiSelect, described options", () => {
  it("keeps header (clipped to 12 chars), multiSelect, description and recommended", () => {
    const out = normalizeAskUserQuestions({
      questions: [
        {
          question: "Which auth method should the API use?",
          header: "Authentication method",
          multiSelect: false,
          options: [
            { label: "OAuth", description: "Sign in with GitHub or Google", recommended: true },
            { label: "JWT", description: "Tokens you issue yourself" },
          ],
        },
        {
          question: "Which checks should run on every PR?",
          header: "CI checks",
          multiSelect: true,
          options: [{ label: "Lint" }, { label: "Tests" }, { label: "Types" }],
        },
      ],
    });
    expect(out).toEqual([
      {
        question: "Which auth method should the API use?",
        header: "Authenticati",
        options: [
          { label: "OAuth", description: "Sign in with GitHub or Google", recommended: true },
          { label: "JWT", description: "Tokens you issue yourself" },
        ],
      },
      {
        question: "Which checks should run on every PR?",
        header: "CI checks",
        multiSelect: true,
        options: [{ label: "Lint" }, { label: "Tests" }, { label: "Types" }],
      },
    ]);
  });

  it("reads a trailing (Recommended) in a label as the flag, and strips it", () => {
    const [q] = normalizeAskUserQuestions({
      questions: [{ question: "Which DB?", options: ["Postgres (Recommended)", { label: "SQLite" }] }],
    });
    expect(q!.options).toEqual([{ label: "Postgres", recommended: true }, { label: "SQLite" }]);
  });

  it("drops multiSelect when there is nothing to pick from, and a header that only repeats the question", () => {
    const out = normalizeAskUserQuestions({
      questions: [
        { question: "Anything else?", multiSelect: true },
        { header: "Deploy target?" },
      ],
    });
    expect(out).toEqual([{ question: "Anything else?" }, { question: "Deploy target?" }]);
  });

  it("dedupes options by label (first wins) and caps at 4", () => {
    const [q] = normalizeAskUserQuestions({
      questions: [
        {
          question: "Pick",
          options: [{ label: "A", description: "first" }, { label: "A", description: "again" }, "B", "C", "D", "E"],
        },
      ],
    });
    expect(q!.options!.map((o) => o.label)).toEqual(["A", "B", "C", "D"]);
    expect(q!.options![0]).toEqual({ label: "A", description: "first" });
  });
});

describe("the answer the model receives", () => {
  it("one question: the answer itself; several: Q/A pairs with (skipped) for blanks", () => {
    expect(combineAskUserAnswers([{ question: "Tabs?" }], ["Tabs"])).toBe("Tabs");
    expect(combineAskUserAnswers([{ question: "DB?" }, { question: "Auth?" }], ["Postgres", " "])).toBe(
      "Q: DB?\nA: Postgres\n\nQ: Auth?\nA: (skipped)",
    );
  });

  it("a multi-select answer is the picked labels joined with \", \", then the typed Other text", () => {
    expect(joinAskUserPicks(["Lint", "Tests"], "")).toBe("Lint, Tests");
    expect(joinAskUserPicks(["Lint"], "  a11y audit ")).toBe("Lint, a11y audit");
    expect(joinAskUserPicks([], "only mine")).toBe("only mine");
    expect(joinAskUserPicks([], "")).toBe("");
  });
});

describe("the wire shape (marker, ACP): old readers still see label strings", () => {
  const qs = normalizeAskUserQuestions({
    questions: [
      {
        question: "Which DB?",
        header: "Database",
        multiSelect: true,
        options: [{ label: "Postgres", description: "Server", recommended: true }, { label: "SQLite" }],
      },
      { question: "Anything else?" },
    ],
  });

  it("writes options as labels and the full options as choices", () => {
    expect(toAskUserWire(qs)).toEqual([
      {
        question: "Which DB?",
        header: "Database",
        multiSelect: true,
        options: ["Postgres", "SQLite"],
        choices: [{ label: "Postgres", description: "Server", recommended: true }, { label: "SQLite" }],
      },
      { question: "Anything else?" },
    ]);
  });

  it("reads back what it wrote, and reads the old string-only shape", () => {
    expect(readAskUserQuestions(toAskUserWire(qs))).toEqual(qs);
    expect(readAskUserQuestions([{ question: "Tabs?", options: ["Tabs", "Spaces"] }])).toEqual([
      { question: "Tabs?", options: [{ label: "Tabs" }, { label: "Spaces" }] },
    ]);
    expect(readAskUserQuestions(null)).toEqual([]);
    expect(readAskUserQuestions([{ nope: 1 }])).toEqual([]);
  });

  it("labels any option shape for a renderer", () => {
    expect(askUserOptionLabel("Tabs")).toBe("Tabs");
    expect(askUserOptionLabel({ label: "Spaces" })).toBe("Spaces");
  });
});
