/**
 * ask_user inline card (v11.1 end-turn): the asking turn has already ENDED
 * when the card shows. Submitting answers records them and starts the
 * continuation stream; the card also re-seeds itself from the persisted
 * `atlarix-questions` artifact after a reload.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  chatMessagesByIdAtom,
  isStreamingByIdAtom,
  pendingUserQuestionByChatIdAtom,
} from "@/atoms/chatAtoms";
import { appendQuestionsArtifact } from "@/lib/chat/ask-user-artifacts";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc() as ReturnType<typeof makeFakeIpc> & {
  submitUserQuestionAnswer: ReturnType<typeof vi.fn>;
};
fakeIpc.submitUserQuestionAnswer = vi.fn(async () => ({
  success: true,
  restream: true,
}));

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

const streamMessage = vi.fn();
vi.mock("@/hooks/useStreamChat", () => ({
  useStreamChat: () => ({ streamMessage }),
}));

import { InlineUserQuestions } from "@/components/chat/InlineUserQuestions";

const CHAT_ID = 21;

describe("InlineUserQuestions", () => {
  beforeEach(() => {
    fakeIpc.submitUserQuestionAnswer.mockClear();
    streamMessage.mockClear();
    const { store } = renderWithProviders(<div />);
    store.set(pendingUserQuestionByChatIdAtom, {});
    store.set(chatMessagesByIdAtom, new Map());
    store.set(isStreamingByIdAtom, new Map());
  });

  it("renders nothing without a pending question", () => {
    const { container } = renderWithProviders(
      <InlineUserQuestions chatId={CHAT_ID} />,
    );
    expect(container.textContent).toBe("");
  });

  // QA (app) #36: "when `--min-length` is not passed?" showed its backticks.
  it("draws the question's and options' code marks", () => {
    const { store, container } = renderWithProviders(
      <InlineUserQuestions chatId={CHAT_ID} />,
    );
    act(() => {
      store.set(pendingUserQuestionByChatIdAtom, {
        [CHAT_ID]: {
          questionId: "q-md",
          question: "Default when `--min-length` is not passed?",
          options: ["`0` — no filtering", "`3`"],
        },
      });
    });
    expect(container.textContent).toContain("Default when --min-length is not passed?");
    expect(container.textContent).not.toContain("`");
    expect(container.querySelectorAll("code").length).toBeGreaterThanOrEqual(3);
  });

  it("single question: option click submits, clears state, and restreams", async () => {
    const { store } = renderWithProviders(
      <InlineUserQuestions chatId={CHAT_ID} />,
    );
    act(() => {
      store.set(pendingUserQuestionByChatIdAtom, {
        [CHAT_ID]: {
          questionId: "q-1",
          question: "Tabs or spaces?",
          options: ["Tabs", "Spaces"],
        },
      });
    });

    expect(screen.getByText("Tabs or spaces?")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Spaces"));

    await waitFor(() => {
      expect(fakeIpc.submitUserQuestionAnswer).toHaveBeenCalledWith(
        CHAT_ID,
        "q-1",
        "Spaces",
        "Tabs or spaces?",
      );
    });
    expect(store.get(pendingUserQuestionByChatIdAtom)[CHAT_ID]).toBeUndefined();
    // v11.1: the asking turn ended — answering starts the continuation stream.
    await waitFor(() => {
      expect(streamMessage).toHaveBeenCalledWith({
        prompt: "",
        chatId: CHAT_ID,
        continueAfterQuestions: true,
      });
    });
  });

  it("multi-question: Submit stays disabled until every question is answered", async () => {
    const { store } = renderWithProviders(
      <InlineUserQuestions chatId={CHAT_ID} />,
    );
    act(() => {
      store.set(pendingUserQuestionByChatIdAtom, {
        [CHAT_ID]: {
          questionId: "q-2",
          question: "Which DB?",
          questions: [
            { question: "Which DB?", options: ["Postgres", "SQLite"] },
            { question: "Auth method?", options: ["OAuth", "JWT"] },
          ],
        },
      });
    });

    expect(
      screen.getByText("2 questions — answer all to continue"),
    ).toBeInTheDocument();
    const submit = screen.getByTestId("inline-user-questions-submit");
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByText("Postgres"));
    expect(submit).toBeDisabled(); // one of two answered
    expect(fakeIpc.submitUserQuestionAnswer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("JWT"));
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(fakeIpc.submitUserQuestionAnswer).toHaveBeenCalledWith(
        CHAT_ID,
        "q-2",
        "Q: Which DB?\nA: Postgres\n\nQ: Auth method?\nA: JWT",
        "2 questions",
      );
    });
    expect(store.get(pendingUserQuestionByChatIdAtom)[CHAT_ID]).toBeUndefined();
  });

  it("free-text question accepts a custom answer", async () => {
    renderWithProviders(<InlineUserQuestions chatId={CHAT_ID} />);
    const { store } = renderWithProviders(
      <InlineUserQuestions chatId={CHAT_ID} />,
    );
    act(() => {
      store.set(pendingUserQuestionByChatIdAtom, {
        [CHAT_ID]: { questionId: "q-3", question: "Project name?" },
      });
    });
    const input = screen.getAllByPlaceholderText("Your answer…")[0];
    fireEvent.change(input, { target: { value: "atlas-x" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(fakeIpc.submitUserQuestionAnswer).toHaveBeenCalledWith(
        CHAT_ID,
        "q-3",
        "atlas-x",
        "Project name?",
      );
    });
  });

  it("re-seeds the card from a persisted atlarix-questions artifact (reload)", async () => {
    const { store } = renderWithProviders(
      <InlineUserQuestions chatId={CHAT_ID} />,
    );
    act(() => {
      store.set(
        chatMessagesByIdAtom,
        new Map([
          [
            CHAT_ID,
            [
              {
                id: 1,
                chatId: CHAT_ID,
                role: "user",
                content: "build it",
                createdAt: new Date(),
              },
              {
                id: 2,
                chatId: CHAT_ID,
                role: "assistant",
                content: appendQuestionsArtifact("Need a decision first.", {
                  questionId: "uq_reload",
                  questions: [
                    { question: "Deploy target?", options: ["Vercel", "Fly"] },
                  ],
                }),
                createdAt: new Date(),
              },
            ] as never,
          ],
        ]),
      );
    });

    await waitFor(() => {
      expect(screen.getByText("Deploy target?")).toBeInTheDocument();
    });
    expect(
      store.get(pendingUserQuestionByChatIdAtom)[CHAT_ID]?.questionId,
    ).toBe("uq_reload");
  });

  it("does NOT re-seed when a user message follows the question turn (answered)", () => {
    const { store, container } = renderWithProviders(
      <InlineUserQuestions chatId={CHAT_ID} />,
    );
    act(() => {
      store.set(
        chatMessagesByIdAtom,
        new Map([
          [
            CHAT_ID,
            [
              {
                id: 2,
                chatId: CHAT_ID,
                role: "assistant",
                content: appendQuestionsArtifact("Need a decision first.", {
                  questionId: "uq_done",
                  questions: [{ question: "Deploy target?" }],
                }),
                createdAt: new Date(),
              },
              {
                id: 3,
                chatId: CHAT_ID,
                role: "user",
                content: "***Q:*** Deploy target? → ***A:*** Vercel",
                createdAt: new Date(),
              },
            ] as never,
          ],
        ]),
      );
    });
    expect(store.get(pendingUserQuestionByChatIdAtom)[CHAT_ID]).toBeUndefined();
    expect(container.textContent).toBe("");
  });
});
