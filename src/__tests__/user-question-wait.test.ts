/**
 * ask_user pause mechanics: tool execution blocks until the renderer submits
 * an answer (or the timeout fires).
 */

import { describe, it, expect } from "vitest";
import {
  waitForUserQuestionAnswer,
  resolveUserQuestionAnswer,
} from "@/ipc/handlers/user_question_wait";

describe("user question wait", () => {
  it("blocks until resolved with the user's answer", async () => {
    const p = waitForUserQuestionAnswer(7, "q1", 5_000);
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false); // still waiting — the stream must pause here

    expect(resolveUserQuestionAnswer(7, "q1", "Option B")).toBe(true);
    await expect(p).resolves.toBe("Option B");
  });

  it("resolving an unknown question is a no-op", () => {
    expect(resolveUserQuestionAnswer(7, "nope", "x")).toBe(false);
  });

  it("times out with a model-readable fallback answer", async () => {
    const p = waitForUserQuestionAnswer(8, "q2", 30);
    await expect(p).resolves.toBe("(timed out waiting for user answer)");
  });

  it("keys by chatId + questionId (no cross-chat resolution)", async () => {
    const p = waitForUserQuestionAnswer(9, "q3", 5_000);
    expect(resolveUserQuestionAnswer(10, "q3", "wrong chat")).toBe(false);
    expect(resolveUserQuestionAnswer(9, "q3", "right chat")).toBe(true);
    await expect(p).resolves.toBe("right chat");
  });
});

// v10.1: multi-question normalization for the ask_user tool
import { normalizeAskUserQuestions } from "@/lib/tools/ask_user_options";

describe("normalizeAskUserQuestions", () => {
  it("wraps the legacy single question form", () => {
    expect(
      normalizeAskUserQuestions({ question: "Tabs or spaces?", options: ["Tabs", "Spaces"] }),
    ).toEqual([{ question: "Tabs or spaces?", options: ["Tabs", "Spaces"] }]);
  });

  it("accepts a questions array with per-question options", () => {
    const out = normalizeAskUserQuestions({
      questions: [
        { question: "Which DB?", options: ["Postgres", "SQLite"] },
        { question: "Project name?" },
        "Deploy target?",
      ],
    });
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ question: "Which DB?", options: ["Postgres", "SQLite"] });
    expect(out[1].question).toBe("Project name?");
    expect(out[2].question).toBe("Deploy target?");
  });

  it("caps at 5 questions and drops empties", () => {
    const out = normalizeAskUserQuestions({
      questions: ["a", "", "b", "c", "d", "e", "f"].map((q) => ({ question: q })),
    });
    expect(out).toHaveLength(5);
  });

  it("returns empty when nothing usable is provided", () => {
    expect(normalizeAskUserQuestions({})).toEqual([]);
  });
});

// v10.1 regression: the ask_user pause marker must escape the registry's
// success envelope — nested `{ success, result: { __ask_user } }` made every
// stream path miss it (no question UI, model invented answers).
import "../lib/tools";
import { ToolRegistry } from "@/lib/tools/registry";

describe("ask_user marker escapes the registry envelope", () => {
  it("ToolRegistry.execute returns the raw __ask_user marker", async () => {
    const result = (await ToolRegistry.execute("ask_user", {
      question: "Tabs or spaces?",
      options: ["Tabs", "Spaces"],
    })) as Record<string, unknown>;
    expect(result.__ask_user).toBe(true);
    expect(result.question).toBe("Tabs or spaces?");
    expect(result.questions).toEqual([
      { question: "Tabs or spaces?", options: ["Tabs", "Spaces"] },
    ]);
    // NOT wrapped: no success/result envelope around the marker.
    expect((result as { result?: unknown }).result).toBeUndefined();
  });

  it("multi-question form survives execute too", async () => {
    const result = (await ToolRegistry.execute("ask_user", {
      questions: [
        { question: "Which DB?", options: ["Postgres", "SQLite"] },
        { question: "Project name?" },
      ],
    })) as Record<string, unknown>;
    expect(result.__ask_user).toBe(true);
    expect((result.questions as unknown[]).length).toBe(2);
  });
});
