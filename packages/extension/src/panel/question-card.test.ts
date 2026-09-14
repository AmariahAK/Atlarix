/**
 * The `ask_user` card.
 *
 * Every assertion here is a thing that was reported from a real session: the
 * options read as text, their order did not match the order the model wrote
 * them in, there was no way to decline to answer, and clicking one looked like
 * it had done nothing because it filled the composer instead of sending.
 */

import { describe, expect, it, vi } from "vitest";
import { SKIP_ANSWER, buildQuestionCard } from "./question-card";

const host = () => {
  const send = vi.fn();
  return { host: { send }, send };
};

const skipButton = (card: HTMLElement) =>
  card.querySelector<HTMLButtonElement>(".ask__skip")!;

const options = (card: HTMLElement) =>
  [...card.querySelectorAll<HTMLButtonElement>(".ask__option")];

const labels = (card: HTMLElement) =>
  options(card).map((o) => o.querySelector(".ask__option-label")?.textContent);

const sendButton = (card: HTMLElement) =>
  card.querySelector<HTMLButtonElement>(".ask__send");

describe("ordering", () => {
  it("renders one row per option, IN ORDER, numbered from 1", () => {
    // The bug: wrapped chips laid four options out as 1 / 2-3 / 4 by text
    // width, so what the user read was not the order the model wrote.
    const { host: h } = host();
    const card = buildQuestionCard(
      [{ question: "What next?", options: ["Alpha", "B", "C", "Delta echo"] }],
      h,
    );
    expect(labels(card)).toEqual(["Alpha", "B", "C", "Delta echo"]);
    expect(
      options(card)
        .map((o) => o.querySelector(".ask__option-num")?.textContent)
        .filter(Boolean),
    ).toEqual(["1", "2", "3", "4"]);
  });

  it("numbers the questions too, but only when there is more than one", () => {
    const { host: h } = host();
    expect(
      buildQuestionCard([{ question: "Which?" }], h).querySelector(
        ".ask__question",
      )?.textContent,
    ).toBe("Which?");
    const many = buildQuestionCard(
      [{ question: "Which?" }, { question: "When?" }],
      h,
    );
    expect(
      [...many.querySelectorAll(".ask__question")].map((q) => q.textContent),
    ).toEqual(["1. Which?", "2. When?"]);
  });
});

describe("one question with options — picking SENDS", () => {
  it("sends the bare option on click, with no second gesture", () => {
    // The reported bug: this filled the composer and waited, so the click read
    // as having done nothing and the answer arrived looking typed.
    const { host: h, send } = host();
    const card = buildQuestionCard(
      [{ question: "Which one?", options: ["Alpha", "Beta"] }],
      h,
    );
    options(card)[1].click();
    expect(send).toHaveBeenCalledWith("Which one?", "Beta");
  });

  it("offers no Send button, because there is nothing left to confirm", () => {
    const { host: h } = host();
    const card = buildQuestionCard(
      [{ question: "Which one?", options: ["Alpha"] }],
      h,
    );
    expect(sendButton(card)).toBeNull();
  });

  it("cannot be answered twice", () => {
    const { host: h, send } = host();
    const card = buildQuestionCard(
      [{ question: "Which one?", options: ["Alpha", "Beta"] }],
      h,
    );
    options(card)[0].click();
    options(card)[1].click();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("Which one?", "Alpha");
  });
});

describe("several questions — picking SELECTS, Send commits", () => {
  const two = [
    { question: "Which one?", options: ["Alpha", "Beta"] },
    { question: "When?", options: ["Today", "Tomorrow"] },
  ];

  it("does not send on a pick", () => {
    const { host: h, send } = host();
    const card = buildQuestionCard(two, h);
    options(card)[0].click();
    expect(send).not.toHaveBeenCalled();
  });

  it("marks the picked option so the choice is visible", () => {
    const { host: h } = host();
    const card = buildQuestionCard(two, h);
    options(card)[1].click();
    expect(options(card).map((o) => o.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
      "false",
    ]);
  });

  it("keeps Send disabled until every question is answered", () => {
    const { host: h } = host();
    const card = buildQuestionCard(two, h);
    expect(sendButton(card)?.disabled).toBe(true);
    options(card)[0].click();
    expect(sendButton(card)?.disabled).toBe(true);
    options(card)[2].click();
    expect(sendButton(card)?.disabled).toBe(false);
  });

  it("pairs each answer with its question", () => {
    // Without this the model gets several answers in a row and no way to tell
    // which belongs to which.
    const { host: h, send } = host();
    const card = buildQuestionCard(two, h);
    options(card)[0].click();
    // 0,1 = Q1's options; 2,3 = Q2's. There is no per-question skip any more.
    options(card)[2].click();
    sendButton(card)!.click();
    // `questionText` is a COUNT for several — the desktop's own choice, since
    // no single question names the batch.
    expect(send).toHaveBeenCalledWith(
      "2 questions",
      "Q: Which one?\nA: Alpha\n\nQ: When?\nA: Today",
    );
  });
});

describe("typing your own answer", () => {
  it("counts as this question's answer", () => {
    const { host: h, send } = host();
    const card = buildQuestionCard(
      [{ question: "Which one?", options: ["Alpha"] }],
      h,
    );
    const field = card.querySelector<HTMLInputElement>(".ask__custom")!;
    field.value = "something else entirely";
    field.dispatchEvent(new Event("input"));
    expect(send).not.toHaveBeenCalled(); // typing is not committing

    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", cancelable: true }),
    );
    expect(send).toHaveBeenCalledWith("Which one?", "something else entirely");
  });

  it("is the only way to answer a question with no options, so Send appears", () => {
    const { host: h, send } = host();
    const card = buildQuestionCard([{ question: "Anything else?" }], h);
    expect(sendButton(card)?.disabled).toBe(true);
    const field = card.querySelector<HTMLInputElement>(".ask__custom")!;
    field.value = "yes, this";
    field.dispatchEvent(new Event("input"));
    expect(sendButton(card)?.disabled).toBe(false);
    sendButton(card)!.click();
    expect(send).toHaveBeenCalledWith("Anything else?", "yes, this");
  });
});

describe("skip", () => {
  it("is LAST — after the options and after the custom input", () => {
    // It used to sit between the options and the free-text field, so the last
    // thing before "Something else…" was an escape hatch.
    const { host: h } = host();
    const card = buildQuestionCard(
      [{ question: "Which one?", options: ["Alpha"] }],
      h,
    );
    const order = [...card.querySelectorAll(".ask__option, .ask__custom, .ask__skip")]
      .map((el) => el.className.split(" ")[0]);
    expect(order).toEqual(["ask__option", "ask__custom", "ask__skip"]);
  });

  it("is ONE button for the card, not one per question", () => {
    const { host: h } = host();
    const card = buildQuestionCard(
      [{ question: "A?", options: ["x"] }, { question: "B?", options: ["y"] }],
      h,
    );
    expect(card.querySelectorAll(".ask__skip")).toHaveLength(1);
    expect(skipButton(card).textContent).toBe("Skip remaining");
  });

  it("is offered even when a click alone could answer, so Send is not", () => {
    const { host: h } = host();
    const card = buildQuestionCard(
      [{ question: "Which one?", options: ["Alpha"] }],
      h,
    );
    expect(skipButton(card)).not.toBeNull();
    expect(sendButton(card)).toBeNull();
  });

  it("SUBMITS — it is not a dismiss", () => {
    const { host: h, send } = host();
    const card = buildQuestionCard(
      [{ question: "Which one?", options: ["Alpha"] }],
      h,
    );
    skipButton(card).click();
    expect(send).toHaveBeenCalledWith("Which one?", SKIP_ANSWER);
    expect(SKIP_ANSWER).toBe("(skipped)");
  });

  it("KEEPS answers already given and fills only the blanks", () => {
    // The assertion that catches "Skip overwrites everything". Two of three
    // answered and Skip pressed must send those two.
    const { host: h, send } = host();
    const card = buildQuestionCard(
      [
        { question: "A?", options: ["one"] },
        { question: "B?", options: ["two"] },
        { question: "C?", options: ["three"] },
      ],
      h,
    );
    options(card)[0].click();
    options(card)[1].click();
    skipButton(card).click();
    expect(send).toHaveBeenCalledWith(
      "3 questions",
      `Q: A?\nA: one\n\nQ: B?\nA: two\n\nQ: C?\nA: ${SKIP_ANSWER}`,
    );
  });
});

describe("number keys", () => {
  const card = () =>
    buildQuestionCard(
      [{ question: "Which one?", options: ["Alpha", "Beta", "Gamma"] }],
      host().host,
    );

  it("picks an option on a single-question card", () => {
    const { host: h, send } = host();
    const c = buildQuestionCard(
      [{ question: "Which one?", options: ["Alpha", "Beta"] }],
      h,
    );
    c.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    expect(send).toHaveBeenCalledWith("Which one?", "Beta");
  });

  it("does nothing while focus is in the custom field — that is TYPING", () => {
    const { host: h, send } = host();
    const c = buildQuestionCard(
      [{ question: "Which one?", options: ["Alpha", "Beta"] }],
      h,
    );
    const field = c.querySelector<HTMLInputElement>(".ask__custom")!;
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "2", bubbles: true }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores a number with no option behind it", () => {
    const c = card();
    expect(() =>
      c.dispatchEvent(new KeyboardEvent("keydown", { key: "9", bubbles: true })),
    ).not.toThrow();
  });
});

describe("it is announced as a choice, not as prose", () => {
  it("uses real buttons in a listbox", () => {
    const { host: h } = host();
    const card = buildQuestionCard(
      [{ question: "Which one?", options: ["Alpha", "Beta"] }],
      h,
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
    const { host: h } = host();
    const card = buildQuestionCard(
      [{ question: "A?", options: ["x"] }, { question: "B?" }],
      h,
    );
    const used = new Set<string>();
    for (const el of [card, ...card.querySelectorAll("*")]) {
      for (const cls of el.classList) used.add(cls);
    }
    expect([...used].sort()).toEqual([
      "ask",
      "ask__actions",
      "ask__block",
      "ask__custom",
      "ask__header",
      "ask__option",
      "ask__option-label",
      "ask__option-num",
      "ask__options",
      "ask__question",
      "ask__send",
      "ask__skip",
      "button",
    ]);
  });
});
