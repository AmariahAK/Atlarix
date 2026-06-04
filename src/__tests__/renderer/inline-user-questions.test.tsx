/**
 * ask_user inline card (v10.1): single questions submit on option click;
 * multi-question batches require every answer before Submit enables; the
 * combined readable Q→A string goes back to the model.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  askUserStreamFreezeBaselineByChatIdAtom,
  pendingUserQuestionByChatIdAtom,
} from "@/atoms/chatAtoms";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc() as ReturnType<typeof makeFakeIpc> & {
  submitUserQuestionAnswer: ReturnType<typeof vi.fn>;
};
fakeIpc.submitUserQuestionAnswer = vi.fn(async () => undefined);

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

import { InlineUserQuestions } from "@/components/chat/InlineUserQuestions";

const CHAT_ID = 21;

describe("InlineUserQuestions", () => {
  beforeEach(() => {
    fakeIpc.submitUserQuestionAnswer.mockClear();
    const { store } = renderWithProviders(<div />);
    store.set(pendingUserQuestionByChatIdAtom, {});
    store.set(askUserStreamFreezeBaselineByChatIdAtom, {});
  });

  it("renders nothing without a pending question", () => {
    const { container } = renderWithProviders(
      <InlineUserQuestions chatId={CHAT_ID} />,
    );
    expect(container.textContent).toBe("");
  });

  it("single question: clicking an option submits immediately and clears state", async () => {
    const { store } = renderWithProviders(<InlineUserQuestions chatId={CHAT_ID} />);
    act(() => {
      store.set(pendingUserQuestionByChatIdAtom, {
        [CHAT_ID]: {
          questionId: "q-1",
          question: "Tabs or spaces?",
          options: ["Tabs", "Spaces"],
        },
      });
      store.set(askUserStreamFreezeBaselineByChatIdAtom, { [CHAT_ID]: "frozen" });
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
    expect(
      store.get(askUserStreamFreezeBaselineByChatIdAtom)[CHAT_ID],
    ).toBeUndefined();
  });

  it("multi-question: Submit stays disabled until every question is answered", async () => {
    const { store } = renderWithProviders(<InlineUserQuestions chatId={CHAT_ID} />);
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
    const { store } = renderWithProviders(<InlineUserQuestions chatId={CHAT_ID} />);
    act(() => {
      store.set(pendingUserQuestionByChatIdAtom, {
        [CHAT_ID]: { questionId: "q-3", question: "Project name?" },
      });
    });
    const input = screen.getByPlaceholderText("Your answer…");
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
});
