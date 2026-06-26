import { describe, expect, it } from "vitest";
import { buildContinueAfterQuestionsPrompt } from "@/lib/chat/stream-transport";

describe("buildContinueAfterQuestionsPrompt", () => {
  it("system auto-wake (assistant is the last message) → react-to-event, NOT re-answer", () => {
    // A background task finished / scheduled check fired: the model's own turn
    // is the most recent message, no fresh user input. Must NOT re-feed the
    // user's earlier question (that caused the repeated re-answering).
    const out = buildContinueAfterQuestionsPrompt([
      { role: "user", content: "can you check sub-agents like background tasks?" },
      { role: "assistant", content: "Yes — same pattern. [answered]" },
    ]);
    expect(out).toContain("System continuation");
    expect(out).toContain("Do NOT repeat or re-answer");
    expect(out).not.toContain("can you check sub-agents");
  });

  it("ask_user answer resume (user is the last message) → reconstructs it", () => {
    const out = buildContinueAfterQuestionsPrompt([
      { role: "user", content: "first ask" },
      { role: "assistant", content: "a question?" },
      { role: "user", content: "ANSWER: option B" },
    ]);
    expect(out).toContain("ANSWER: option B");
    expect(out).not.toContain("System continuation");
  });

  it("single user message round-trips unchanged", () => {
    expect(
      buildContinueAfterQuestionsPrompt([{ role: "user", content: "do the thing" }]),
    ).toBe("do the thing");
  });
});
