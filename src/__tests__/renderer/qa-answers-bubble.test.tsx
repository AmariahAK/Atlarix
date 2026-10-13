/**
 * QA (app) #21: the answers to the agent's questions showed as
 * "Q: 2 questions → A: Q: src/tally.js currently… A: Fix tally.js…" — the
 * stored line, markdown and all. The stored text is what the model reads and
 * stays as it is; the bubble shows each question with its answer.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";
import { parseQaAnswers } from "@/lib/interactive-qa-format";

const fakeIpc = makeFakeIpc();
vi.mock("@/ipc/ipc_client", () => ({ IpcClient: { getInstance: () => fakeIpc } }));

import { SimpleMessage } from "@/components/SimpleMessage";
import type { Message } from "@/ipc/ipc_types";

const STORED =
  "***Q:*** 2 questions → ***A:*** Q: src/tally.js currently fails all 4 of its own tests. Should fixing it be part of this work?\n" +
  "A: Fix tally.js so its tests pass (recommended)\n\n" +
  "Q: When --top is omitted, how many words should the CLI print?\n" +
  "A: 10";

describe("answers to the agent's questions", () => {
  it("parse into question/answer pairs", () => {
    expect(parseQaAnswers(STORED)).toEqual([
      { q: "src/tally.js currently fails all 4 of its own tests. Should fixing it be part of this work?", a: "Fix tally.js so its tests pass (recommended)" },
      { q: "When --top is omitted, how many words should the CLI print?", a: "10" },
    ]);
    expect(parseQaAnswers("***Q:*** Which DB? → ***A:*** SQLite")).toEqual([{ q: "Which DB?", a: "SQLite" }]);
    expect(parseQaAnswers("just a message")).toBeNull();
  });

  it("show each question with its answer, without the stored markup", () => {
    renderWithProviders(
      <SimpleMessage message={{ id: 3, role: "user", content: STORED } as unknown as Message} chatId={7} />,
    );
    expect(screen.getByText("When --top is omitted, how many words should the CLI print?")).toBeTruthy();
    expect(screen.getByText("10")).toBeTruthy();
    expect(screen.queryByText(/2 questions/)).toBeNull();
    expect(screen.queryByText(/\*\*\*/)).toBeNull();
  });
});
