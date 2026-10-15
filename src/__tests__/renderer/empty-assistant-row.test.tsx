/**
 * A turn refused before its first token must not leave an empty bubble.
 *
 * The placeholder assistant message is created with `content: ""` and broadcast to the
 * renderer BEFORE the model client is constructed, so a refusal at the wallet gate left a
 * bare `bg-muted` box under a Bot header — nothing inside it, and nothing that could ever
 * fill it. The refusal card below explains what happened; the empty bubble above it just
 * read as a broken render.
 *
 * The placeholder cannot simply not be created: its id IS the turn id that the streaming
 * subsystem keys on (`response-chunk-update`, `finalize`, the task ledger). So the fix is
 * at render, and the risk is over-reach — a legitimately content-empty assistant row can
 * still carry tool cards, thinking and sources, and those come from ATOMS rather than from
 * `content`. Hiding one of those would erase the record of work the agent actually did.
 *
 * Hence the shape of this file: one test that the empty row disappears, and several that
 * near-miss rows survive. The survivors are the ones that matter — a naive
 * `!content → return null` passes the first and fails those.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDefaultStore } from "jotai";
import {
  completedStreamThreadByAssistantMessageIdAtom,
  sourcesByAssistantMessageIdAtom,
} from "@/atoms/chatAtoms";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

import { SimpleMessage } from "@/components/SimpleMessage";
import type { Message } from "@/ipc/ipc_types";

const MSG_ID = 4242;
const CHAT_ID = 7;

function assistantMessage(content: string): Message {
  return {
    id: MSG_ID,
    role: "assistant",
    content,
    approvalState: null,
    commitHash: null,
  } as unknown as Message;
}

/** The bubble surface. Its presence is what "a row rendered" means here. */
function bubble(container: HTMLElement) {
  return container.querySelector(".bg-muted");
}

beforeEach(() => {
  const store = getDefaultStore();
  store.set(completedStreamThreadByAssistantMessageIdAtom, {} as never);
  store.set(sourcesByAssistantMessageIdAtom, {} as never);
});

describe("an assistant row with nothing in it", () => {
  it("renders nothing at all when there is no content, no stream and no parts", () => {
    const { container } = renderWithProviders(
      <SimpleMessage
        message={assistantMessage("")}
        isStreaming={false}
        chatId={CHAT_ID}
      />,
    );
    // Not "renders an empty box" — renders NOTHING.
    expect(container.textContent?.trim()).toBe("");
    expect(bubble(container)).toBeNull();
  });

  it("a turn stopped before its first word shows the stop, without a bubble (QA 15.7.1 #7b)", () => {
    const { container, getByText } = renderWithProviders(
      <SimpleMessage
        message={{ ...assistantMessage(""), interrupted: true } as Message}
        isStreaming={false}
        chatId={CHAT_ID}
        onContinue={() => {}}
      />,
    );
    expect(getByText(/interrupted before it finished/)).toBeTruthy();
    expect(getByText("Continue")).toBeTruthy();
    expect(bubble(container)).toBeNull();
  });

  it("still renders while streaming, so the working indicator survives", () => {
    // The case the pre-existing guard already covered, and it must keep working: a turn
    // that has started but produced no token yet shows InlineStreamStatus. It is also
    // exactly why that guard missed the refusal case — an error sets streaming false.
    const { container } = renderWithProviders(
      <SimpleMessage
        message={assistantMessage("")}
        isStreaming={true}
        chatId={CHAT_ID}
      />,
    );
    expect(bubble(container)).not.toBeNull();
  });

  it("still renders a row that has content", () => {
    const { container } = renderWithProviders(
      <SimpleMessage
        message={assistantMessage("Here is the answer.")}
        isStreaming={false}
        chatId={CHAT_ID}
      />,
    );
    expect(container.textContent).toContain("Here is the answer.");
  });

  /**
   * THE IMPORTANT ONE. A tools-only turn has empty `content` and real substance in the
   * atoms, so `!content → return null` would delete it.
   */
  it("still renders a content-empty row that has a completed stream thread", () => {
    getDefaultStore().set(completedStreamThreadByAssistantMessageIdAtom, {
      [MSG_ID]: [{ kind: "tool", id: "t1" }],
    } as never);
    const { container } = renderWithProviders(
      <SimpleMessage
        message={assistantMessage("")}
        isStreaming={false}
        chatId={CHAT_ID}
      />,
    );
    expect(bubble(container)).not.toBeNull();
  });

  it("still renders a content-empty row that has sources", () => {
    getDefaultStore().set(sourcesByAssistantMessageIdAtom, {
      [MSG_ID]: [{ url: "https://example.com", title: "Docs" }],
    } as never);
    const { container } = renderWithProviders(
      <SimpleMessage
        message={assistantMessage("")}
        isStreaming={false}
        chatId={CHAT_ID}
      />,
    );
    expect(bubble(container)).not.toBeNull();
  });

  it("leaves USER rows alone even when empty", () => {
    // The guard is assistant-only; a user row is the user's own doing.
    const { container } = renderWithProviders(
      <SimpleMessage
        message={{ ...assistantMessage(""), role: "user" } as Message}
        isStreaming={false}
        chatId={CHAT_ID}
      />,
    );
    expect(container.querySelector(".bg-user-bubble")).not.toBeNull();
  });
});

// QA (app) #18: a bubble holding a plan card or a mind map was held at its
// content's width (a flex item without min-w-0) and overflowed the chat
// column. jsdom has no layout, so this pins the class; the width itself was
// checked in the packaged app.
describe("a message bubble in a narrow column", () => {
  it("can shrink below its content's width", () => {
    const { container } = renderWithProviders(
      <SimpleMessage message={assistantMessage("A reply.")} chatId={CHAT_ID} />,
    );
    expect(container.querySelector(".group.max-w-3xl")?.classList.contains("min-w-0")).toBe(true);
  });
});
