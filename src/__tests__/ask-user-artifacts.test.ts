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
      { question: "Tabs or spaces?", options: ["Tabs", "Spaces"] },
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
      { question: "Tabs or spaces?", options: ["Tabs", "Spaces"] },
      { question: "Which framework?" },
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
