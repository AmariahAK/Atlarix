import { describe, expect, it } from "vitest";
import {
  buildContinueAfterQuestionsPrompt,
  buildInterruptedContinuePrompt,
} from "@/lib/chat/stream-transport";
import {
  SYSTEM_REMINDER_OPEN,
  SYSTEM_REMINDER_CLOSE,
} from "@/lib/streaming/system-reminder";

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

describe("buildInterruptedContinuePrompt (reconnect resume)", () => {
  it("is framed as an out-of-band <system-reminder>, not a bare user turn", () => {
    // Regression: resuming an interrupted turn used to send the directive as a
    // plain user prompt, so the transcript showed a fake "user said continue"
    // bubble. It must be system-reminder-wrapped so the model (and the display
    // path that suppresses user turns) treats it as a harness resume.
    const out = buildInterruptedContinuePrompt();
    expect(out.startsWith(SYSTEM_REMINDER_OPEN)).toBe(true);
    expect(out.trimEnd().endsWith(SYSTEM_REMINDER_CLOSE)).toBe(true);
    expect(out).toContain("Continue from where you left off");
  });
});
