import { describe, expect, it } from "vitest";
import {
  appendQuestionsArtifact,
  extractQuestionsArtifact,
  stripQuestionsArtifactForDisplay,
} from "@/lib/chat/ask-user-artifacts";

describe("ask-user-artifacts (v11.1 end-turn)", () => {
  const artifact = {
    questionId: "uq_123_abc",
    questions: [
      { question: "Tabs or spaces?", options: [{ label: "Tabs" }, { label: "Spaces" }] },
      { question: "Which framework?" },
    ],
  };

  it("round-trips append → extract", () => {
    const content = appendQuestionsArtifact(
      "I need a couple of decisions before continuing.",
      artifact,
    );
    expect(content).toContain("atlarix-questions:");
    const extracted = extractQuestionsArtifact(content);
    expect(extracted?.questionId).toBe("uq_123_abc");
    expect(extracted?.questions).toEqual([
      { question: "Tabs or spaces?", options: [{ label: "Tabs" }, { label: "Spaces" }] },
      { question: "Which framework?" },
    ]);
  });

  it("carries header, multiSelect, descriptions and recommended through a reload", () => {
    const rich = {
      questionId: "uq_rich",
      questions: [
        {
          question: "Which checks run on every PR?",
          header: "CI checks",
          multiSelect: true,
          options: [
            { label: "Lint", description: "eslint + prettier", recommended: true },
            { label: "Tests" },
          ],
        },
      ],
    };
    const content = appendQuestionsArtifact("Two choices first.", rich);
    expect(extractQuestionsArtifact(content)).toEqual(rich);
    // An older desktop or CLI sharing the database reads `options` as strings.
    const raw = JSON.parse(content.match(/atlarix-questions:(.*) -->/)![1]!);
    expect(raw.questions[0].options).toEqual(["Lint", "Tests"]);
  });

  it("reads a marker an older build wrote (string options)", () => {
    const old = '<!-- atlarix-questions:{"questionId":"uq_old","questions":[{"question":"Tabs?","options":["Tabs","Spaces"]}]} -->';
    expect(extractQuestionsArtifact(old)?.questions).toEqual([
      { question: "Tabs?", options: [{ label: "Tabs" }, { label: "Spaces" }] },
    ]);
  });

  it("strips the marker for display, keeping prose", () => {
    const content = appendQuestionsArtifact("Before the questions.", artifact);
    const display = stripQuestionsArtifactForDisplay(content);
    expect(display).toBe("Before the questions.");
    expect(display).not.toContain("atlarix-questions");
  });

  it("extract returns null on missing/garbage markers", () => {
    expect(extractQuestionsArtifact("plain text")).toBeNull();
    expect(extractQuestionsArtifact(null)).toBeNull();
    expect(
      extractQuestionsArtifact("<!-- atlarix-questions:{not json} -->"),
    ).toBeNull();
    expect(
      extractQuestionsArtifact(
        '<!-- atlarix-questions:{"questionId":"x","questions":[]} -->',
      ),
    ).toBeNull();
  });

  it("uses the LAST marker when several exist", () => {
    const first = appendQuestionsArtifact("a", {
      questionId: "old",
      questions: [{ question: "old q" }],
    });
    const both = appendQuestionsArtifact(first, {
      questionId: "new",
      questions: [{ question: "new q" }],
    });
    expect(extractQuestionsArtifact(both)?.questionId).toBe("new");
  });

  it("handles empty base content", () => {
    const content = appendQuestionsArtifact("", artifact);
    expect(extractQuestionsArtifact(content)?.questionId).toBe("uq_123_abc");
    expect(stripQuestionsArtifactForDisplay(content)).toBe("");
  });
});
