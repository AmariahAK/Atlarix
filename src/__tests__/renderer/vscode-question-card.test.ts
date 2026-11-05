/**
 * The VS Code panel's ask_user card (packages/vscode/webview/chat/transcript.ts):
 * the header chip, each option's description and the recommended one, and
 * multiSelect, where picks toggle and the answer is the labels joined with
 * ", " plus the typed text. It reads both wire shapes, since the CLI behind it
 * can be another build.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const posted = vi.hoisted(() => {
  const list: unknown[] = [];
  (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => list.push(m) });
  return list;
});

import { initTranscript, log, questionPending, showQuestion } from "../../../packages/vscode/webview/chat/transcript";

const answer = vi.fn();

beforeEach(() => {
  answer.mockClear();
  posted.length = 0;
  log.replaceChildren();
  document.body.replaceChildren(log);
  initTranscript({ goBack: vi.fn(), answer, restore: vi.fn() });
});

const card = () => log.querySelector<HTMLElement>(".card.question")!;
const optionButton = (label: string) =>
  [...card().querySelectorAll<HTMLButtonElement>("button.option")].find((b) => b.querySelector(".option__label")?.textContent === label)!;
const send = () => [...card().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Answer")!.click();

describe("the VS Code question card", () => {
  it("shows the header, descriptions and the recommended option (from choices)", () => {
    showQuestion([
      {
        question: "Which auth method?",
        header: "Auth method",
        options: ["OAuth", "JWT"],
        choices: [
          { label: "OAuth", description: "Sign in with GitHub", recommended: true },
          { label: "JWT", description: "Tokens you issue" },
        ],
      },
    ]);
    expect(card().querySelector(".card__header")?.textContent).toBe("Auth method");
    expect(optionButton("OAuth").querySelector(".option__desc")?.textContent).toBe("Sign in with GitHub");
    expect(optionButton("OAuth").querySelector(".option__rec")?.textContent).toBe("Recommended");
    expect(optionButton("JWT").querySelector(".option__rec")).toBeNull();
    optionButton("JWT").click();
    send();
    expect(answer).toHaveBeenCalledWith("JWT", ["JWT"]);
  });

  it("still reads an older CLI's string options", () => {
    showQuestion([{ question: "Tabs?", options: ["Tabs", "Spaces"] }]);
    expect(optionButton("Spaces")).toBeTruthy();
    expect(questionPending()?.[0]?.question).toBe("Tabs?");
  });

  it("multiSelect: picks toggle; the answer is the labels joined with \", \" plus the typed text", () => {
    showQuestion([
      {
        question: "Which checks?",
        multiSelect: true,
        choices: [{ label: "Lint" }, { label: "Tests" }, { label: "Types" }],
      },
    ]);
    optionButton("Types").click();
    optionButton("Lint").click();
    optionButton("Tests").click();
    optionButton("Tests").click(); // off again
    expect(optionButton("Lint").classList.contains("chosen")).toBe(true);
    expect(optionButton("Tests").classList.contains("chosen")).toBe(false);
    const free = card().querySelector<HTMLInputElement>("input.field")!;
    expect(free.value).toBe(""); // picks don't fill the Other field
    free.value = "a11y audit";
    free.dispatchEvent(new Event("input"));
    send();
    expect(answer).toHaveBeenCalledWith("Lint, Types, a11y audit", ["Lint, Types, a11y audit"]);
  });
});
