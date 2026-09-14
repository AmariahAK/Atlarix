/**
 * The `ask_user` card.
 *
 * Every assertion here is a thing that was reported as wrong on the first
 * version: the options read as text, their order did not match the order the
 * model wrote them in, and there was no way to decline to answer.
 */

import { describe, expect, it, vi } from "vitest";
import { SKIP_ANSWER, buildQuestionCard } from "./question-card";

const options = (card: HTMLElement) =>
  [...card.querySelectorAll<HTMLButtonElement>(".ask__option")];

const labels = (card: HTMLElement) =>
  options(card).map((o) => o.querySelector(".ask__option-label")?.textContent);

describe("ordering", () => {
  it("renders one row per option, IN ORDER, numbered from 1", () => {
    // The bug: wrapped chips laid four options out as 1 / 2-3 / 4 by text
    // width, so what the user read was not the order the model wrote.
    const card = buildQuestionCard(
      [{ question: "What next?", options: ["Alpha", "B", "C", "Delta echo"] }],
      () => {},
    );
    expect(labels(card)).toEqual([
      "Alpha",
      "B",
      "C",
      "Delta echo",
      "Skip — no preference",
    ]);
    expect(
      options(card)
        .map((o) => o.querySelector(".ask__option-num")?.textContent)
        .filter(Boolean),
    ).toEqual(["1", "2", "3", "4"]);
  });

  it("numbers the questions too, but only when there is more than one", () => {
    const one = buildQuestionCard([{ question: "Which?" }], () => {});
    expect(one.querySelector(".ask__question")?.textContent).toBe("Which?");

    const many = buildQuestionCard(
      [{ question: "Which?" }, { question: "When?" }],
      () => {},
    );
    expect(
      [...many.querySelectorAll(".ask__question")].map((q) => q.textContent),
    ).toEqual(["1. Which?", "2. When?"]);
  });
});

describe("answering", () => {
  it("sends the bare option when there is one question", () => {
    const fill = vi.fn();
    const card = buildQuestionCard(
      [{ question: "Which one?", options: ["Alpha"] }],
      fill,
    );
    options(card)[0].click();
    expect(fill).toHaveBeenCalledWith("Alpha");
  });

  it("pairs each answer with its question when there are several", () => {
    // The user clicks one at a time, so there is no later moment to pair them.
    // Without this the model gets three answers in a row and no way to tell
    // which belongs to which.
    const fill = vi.fn();
    const card = buildQuestionCard(
      [
        { question: "Which one?", options: ["Alpha"] },
        { question: "When?", options: ["Today"] },
      ],
      fill,
    );
    options(card)[0].click();
    options(card)[2].click();
    expect(fill.mock.calls.map((c) => c[0])).toEqual([
      "Q: Which one?\nA: Alpha",
      "Q: When?\nA: Today",
    ]);
  });
});

describe("skip", () => {
  it("is offered on every question, even one with no options", () => {
    const card = buildQuestionCard([{ question: "Anything else?" }], () => {});
    expect(labels(card)).toEqual(["Skip — no preference"]);
  });

  it("sends the desktop's skip token, so both surfaces say it the same way", () => {
    const fill = vi.fn();
    const card = buildQuestionCard(
      [{ question: "Which one?", options: ["Alpha"] }],
      fill,
    );
    card.querySelector<HTMLButtonElement>(".ask__option--skip")!.click();
    expect(fill).toHaveBeenCalledWith(SKIP_ANSWER);
    expect(SKIP_ANSWER).toBe("(skipped)");
  });
});

describe("it is announced as a choice, not as prose", () => {
  it("uses real buttons in a listbox", () => {
    const card = buildQuestionCard(
      [{ question: "Which one?", options: ["Alpha", "Beta"] }],
      () => {},
    );
    expect(card.querySelector(".ask__options")?.getAttribute("role")).toBe(
      "listbox",
    );
    for (const o of options(card)) {
      expect(o.tagName).toBe("BUTTON");
      // `type` matters: inside any form a default-type button submits it.
      expect(o.type).toBe("button");
    }
  });
});

/**
 * The class names are a contract with `sidepanel.css`, which is a separate file
 * the build copies verbatim. Rename one here and the element renders UNSTYLED —
 * no error, no console message, nothing red. That is not hypothetical: these
 * rows were reported as looking "just like text", which is exactly what an
 * unstyled button looks like.
 *
 * Pinned from this side rather than by reading the stylesheet, because Vitest
 * hands back an EMPTY STRING for a `?raw` CSS import — its CSS handling claims
 * the file before the query does — so a test that greps the stylesheet passes
 * whatever it says. A guard that cannot fail is worse than none.
 */
describe("the class contract with sidepanel.css", () => {
  it("emits exactly the classes the stylesheet is written against", () => {
    const card = buildQuestionCard(
      [{ question: "Which one?", options: ["Alpha"] }],
      () => {},
    );
    const used = new Set<string>();
    for (const el of [card, ...card.querySelectorAll("*")]) {
      for (const cls of el.classList) used.add(cls);
    }
    expect([...used].sort()).toEqual([
      "ask",
      "ask__block",
      "ask__header",
      "ask__note",
      "ask__option",
      "ask__option--skip",
      "ask__option-label",
      "ask__option-num",
      "ask__options",
      "ask__question",
    ]);
  });
});
