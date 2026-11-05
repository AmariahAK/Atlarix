/**
 * `ask_user`.
 *
 * The normalisation itself is the desktop's and is tested there; what is tested
 * here is the part that is this package's own — that asking ENDS THE TURN, that
 * asking nothing does NOT, and that a recorded call can be read back into
 * questions after a reload.
 */

import { describe, expect, it } from "vitest";
import {
  answeredAskCalls,
  askUser,
  askUserLabel,
  questionsFromArgs,
} from "./ask-user";

describe("running the tool", () => {
  it("ends the turn when something was actually asked", () => {
    const out = askUser({ question: "Which account did you mean?" });
    expect(out.endsTurn).toBe(true);
    expect(out.content).toMatch(/YOUR TURN HAS ENDED/);
  });

  it("does NOT end the turn when nothing readable was asked", () => {
    // The failure this prevents is silent and looks like a crash: the turn
    // stops, no question renders, and the panel just sits there.
    for (const args of [{}, { question: "" }, { questions: [] }]) {
      const out = askUser(args);
      expect(out.endsTurn).toBeUndefined();
      expect(out.content).toMatch(/still running/);
    }
  });

  it("tells the model not to answer on the user's behalf", () => {
    // A model that ends its turn and then writes the answer itself has asked a
    // rhetorical question, which is worse than not asking.
    const out = askUser({ question: "Which one?" });
    expect(out.content).toMatch(/do not answer on their behalf/i);
  });

  it("labels the transcript by how many were asked", () => {
    expect(askUserLabel([{ question: "a" }])).toBe("Asked a question");
    expect(askUserLabel([{ question: "a" }, { question: "b" }])).toBe(
      "Asked 2 questions",
    );
  });
});

describe("reading a recorded call back", () => {
  it("recovers the questions from the stored arguments", () => {
    // This is what makes a question survive closing and reopening the panel:
    // nothing is kept in module state, it is all re-derived from the call that
    // `saveSession` already persists.
    const raw = JSON.stringify({
      questions: [
        { question: "Which account?", options: ["work", "personal"] },
        { question: "Post it now?" },
      ],
    });
    const out = questionsFromArgs(raw);
    expect(out).toHaveLength(2);
    expect(out[0].question).toBe("Which account?");
    expect(out[0].options).toEqual([{ label: "work" }, { label: "personal" }]);
    expect(out[1].options).toBeUndefined();
  });

  it("survives arguments that are not JSON at all", () => {
    // A transcript rebuild must never throw: one bad row would blank the whole
    // conversation rather than one chip.
    expect(questionsFromArgs("")).toEqual([]);
    expect(questionsFromArgs("{oh no")).toEqual([]);
    expect(questionsFromArgs("null")).toEqual([]);
    expect(questionsFromArgs('"a string"')).toEqual([]);
    expect(questionsFromArgs("[1,2]")).toEqual([]);
  });

  it("normalises the shapes models actually send", () => {
    // Each of these was a real model doing a real strange thing; the desktop
    // paid for them once and this package imports rather than re-learns them.
    // `{label}` objects instead of strings — without coercion every option
    // collapses to "[object Object]" and dedups to one.
    expect(
      questionsFromArgs(
        JSON.stringify({
          question: "Which?",
          options: [{ label: "work" }, { label: "personal" }],
        }),
      )[0].options,
    ).toEqual([{ label: "work" }, { label: "personal" }]);

    // `choices` as an alias for `options` — accepted, never advertised.
    expect(
      questionsFromArgs(
        JSON.stringify({ question: "Which?", choices: ["a", "b"] }),
      )[0].options,
    ).toEqual([{ label: "a" }, { label: "b" }]);

    // Options inlined into the question as numbered lines.
    const inline = questionsFromArgs(
      JSON.stringify({ question: "Which one?\n1. work\n2. personal" }),
    );
    expect(inline[0].question).toBe("Which one?");
    expect(inline[0].options).toEqual([{ label: "work" }, { label: "personal" }]);
  });

  it("caps what it returns, so the panel cannot be flooded", () => {
    const many = questionsFromArgs(
      JSON.stringify({
        questions: Array.from({ length: 12 }, (_, i) => ({ question: `q${i}` })),
      }),
    );
    expect(many.length).toBeLessThanOrEqual(5);

    const opts = questionsFromArgs(
      JSON.stringify({
        question: "Which?",
        options: ["a", "b", "c", "d", "e", "f"],
      }),
    )[0].options;
    expect(opts?.length).toBeLessThanOrEqual(4);
  });
});

/**
 * Whether a recorded question still needs answering.
 *
 * The failure this guards is invisible until someone reopens a conversation the
 * next day and finds the question card sitting above the answer they already
 * gave. Nothing in the live path would ever show it.
 */
describe("answeredAskCalls", () => {
  const ask = (id: string) => ({
    role: "assistant",
    tool_calls: [{ id, function: { name: "ask_user" } }],
  });
  const result = (id: string) => ({ role: "tool", tool_call_id: id });
  const reply = { role: "user" };

  it("is answered when a user message follows the tool result", () => {
    expect([...answeredAskCalls([ask("a"), result("a"), reply])]).toEqual(["a"]);
  });

  it("is NOT answered when the conversation ends on the question", () => {
    // The whole reason the card is re-derived rather than stored: closing the
    // panel on an unanswered question must not lose it.
    expect([...answeredAskCalls([ask("a"), result("a")])]).toEqual([]);
  });

  it("counts a composer message as the answer", () => {
    // They answered; they just did not click. The desktop's composer supersedes
    // its card the same way.
    expect([...answeredAskCalls([ask("a"), result("a"), reply])]).toEqual(["a"]);
  });

  it("leaves a LATER question open when an earlier one was answered", () => {
    expect([
      ...answeredAskCalls([ask("a"), result("a"), reply, ask("b"), result("b")]),
    ]).toEqual(["a"]);
  });

  it("closes every question still open when the reply lands", () => {
    // A model told to batch that asked twice anyway: one reply answered both,
    // because that is what actually happened.
    expect(
      [...answeredAskCalls([ask("a"), result("a"), ask("b"), result("b"), reply])].sort(),
    ).toEqual(["a", "b"]);
  });

  it("ignores tool results that are not ask_user", () => {
    const other = {
      role: "assistant",
      tool_calls: [{ id: "z", function: { name: "read_page" } }],
    };
    expect([...answeredAskCalls([other, result("z"), reply])]).toEqual([]);
  });
});
