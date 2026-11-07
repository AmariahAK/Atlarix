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
          options: [{ label: "`0` — no filtering" }, { label: "`3`" }],
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
          options: [{ label: "Tabs" }, { label: "Spaces" }],
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

  // W4 (Windows fresh-install QA, 2026-11-07): Explore is told to "call
  // ask_user to switch to Build/Debug". The user picked "Yes, switch to Build",
  // nothing switched, and the next reply asked them to find the mode chip.
  it("an answer that picks Build switches the mode and continues in it (W4)", async () => {
    // Saving settings runs the telemetry opt-out, which touches localStorage —
    // and jsdom's stub here has no removeItem.
    const mem = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => void mem.set(k, String(v)),
        removeItem: (k: string) => void mem.delete(k),
        clear: () => mem.clear(),
        key: (i: number) => Array.from(mem.keys())[i] ?? null,
        get length() {
          return mem.size;
        },
      },
    });
    const { store } = renderWithProviders(
      <InlineUserQuestions chatId={CHAT_ID} />,
    );
    act(() => {
      store.set(pendingUserQuestionByChatIdAtom, {
        [CHAT_ID]: {
          questionId: "q-mode",
          question: "This needs a file edit. Switch to Build?",
          options: ["Yes, switch to Build (Recommended)", "No, stay in Explore"],
        },
      });
    });

    fireEvent.click(screen.getByText("Yes, switch to Build (Recommended)"));

    await waitFor(() => {
      expect(streamMessage).toHaveBeenCalledWith({
        prompt: "",
        chatId: CHAT_ID,
        continueAfterQuestions: true,
        workModeOverride: "build",
      });
    });
    await waitFor(() => {
      expect(fakeIpc.setUserSettings).toHaveBeenCalledWith(
        expect.objectContaining({ workModePreference: "build" }),
      );
    });
  });

  it("an answer that declines the switch changes nothing", async () => {
    const { store } = renderWithProviders(
      <InlineUserQuestions chatId={CHAT_ID} />,
    );
    act(() => {
      store.set(pendingUserQuestionByChatIdAtom, {
        [CHAT_ID]: {
          questionId: "q-mode-no",
          question: "This needs a file edit. Switch to Build?",
          options: ["Yes, switch to Build (Recommended)", "No, stay in Explore"],
        },
      });
    });

    fireEvent.click(screen.getByText("No, stay in Explore"));

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
            { question: "Which DB?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
            { question: "Auth method?", options: [{ label: "OAuth" }, { label: "JWT" }] },
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
                    { question: "Deploy target?", options: [{ label: "Vercel" }, { label: "Fly" }] },
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

  it("shows the header chip, each option's description and the recommended one", () => {
    const { store, container } = renderWithProviders(<InlineUserQuestions chatId={CHAT_ID} />);
    act(() => {
      store.set(pendingUserQuestionByChatIdAtom, {
        [CHAT_ID]: {
          questionId: "q-cc",
          question: "Which auth method?",
          questions: [
            {
              question: "Which auth method?",
              header: "Auth method",
              options: [
                { label: "OAuth", description: "Sign in with GitHub or Google", recommended: true },
                { label: "JWT", description: "Tokens you issue yourself" },
              ],
            },
          ],
        },
      });
    });
    expect(screen.getByTestId("ask-header-0")).toHaveTextContent("Auth method");
    expect(screen.getByText("Sign in with GitHub or Google")).toBeInTheDocument();
    expect(screen.getByText("Tokens you issue yourself")).toBeInTheDocument();
    const recommended = container.querySelectorAll("[data-testid='ask-recommended']");
    expect(recommended).toHaveLength(1);
    expect(recommended[0]!.closest("button")).toHaveTextContent("OAuth");
  });

  it("multiSelect: clicks toggle (no instant send); Submit sends the labels joined with \", \" plus the typed Other", async () => {
    const { store } = renderWithProviders(<InlineUserQuestions chatId={CHAT_ID} />);
    act(() => {
      store.set(pendingUserQuestionByChatIdAtom, {
        [CHAT_ID]: {
          questionId: "q-multi",
          question: "Which checks?",
          questions: [
            {
              question: "Which checks?",
              multiSelect: true,
              options: [{ label: "Lint" }, { label: "Tests" }, { label: "Types" }],
            },
          ],
        },
      });
    });
    const submit = screen.getByTestId("inline-user-questions-submit");
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByText("Lint"));
    fireEvent.click(screen.getByText("Types"));
    fireEvent.click(screen.getByText("Tests"));
    fireEvent.click(screen.getByText("Types")); // off again
    expect(fakeIpc.submitUserQuestionAnswer).not.toHaveBeenCalled();
    expect(screen.getByText("Lint").closest("button")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Types").closest("button")).toHaveAttribute("aria-selected", "false");
    fireEvent.change(screen.getByPlaceholderText("Something else"), { target: { value: "a11y audit" } });
    // Typing Other keeps the picks (Claude Code once dropped one or the other).
    expect(screen.getByText("Lint").closest("button")).toHaveAttribute("aria-selected", "true");
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);
    await waitFor(() => {
      expect(fakeIpc.submitUserQuestionAnswer).toHaveBeenCalledWith(
        CHAT_ID,
        "q-multi",
        "Lint, Tests, a11y audit",
        "Which checks?",
      );
    });
  });

  it("re-seeds header, descriptions and multiSelect from the persisted marker", async () => {
    const { store } = renderWithProviders(<InlineUserQuestions chatId={CHAT_ID} />);
    const content = appendQuestionsArtifact("Two quick choices.", {
      questionId: "q-reload",
      questions: [
        {
          question: "Which checks?",
          header: "CI checks",
          multiSelect: true,
          options: [{ label: "Lint", description: "eslint" }, { label: "Tests" }],
        },
      ],
    });
    act(() => {
      store.set(
        chatMessagesByIdAtom,
        new Map([[CHAT_ID, [{ id: 1, chatId: CHAT_ID, role: "assistant", content, createdAt: new Date() }] as never]]),
      );
    });
    await waitFor(() => expect(screen.getByTestId("ask-header-0")).toHaveTextContent("CI checks"));
    expect(screen.getByText("eslint")).toBeInTheDocument();
    expect(screen.getByTestId("inline-user-questions-submit")).toBeInTheDocument();
  });
});
