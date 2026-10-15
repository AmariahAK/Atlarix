/**
 * A stopped reply shows one marker, "interrupted… Continue", while the chat is
 * live and after a reopen, and never main's note for the model as its text
 * (QA 15.7.1 #7: live there was no marker; a stop before the first token
 * reopened as "[Response cancelled by user]").
 */
import { describe, expect, it } from "vitest";
import type { Message } from "@/ipc/ipc_types";
import { sessionMessagesToUiMessages } from "@/lib/chat/hydrate-session-into-chat";
import { markStoppedReply } from "@/lib/chat/stopped-reply";

const row = (id: string, role: string, content: string, status?: string) => ({
  id,
  role,
  content,
  status: status ?? null,
  createdAt: new Date(0),
});

describe("a reopened stopped reply", () => {
  it("reads as interrupted, without the note for the model", () => {
    const ui = sessionMessagesToUiMessages("s", 1, [
      row("u1", "user", "explain calc.py"),
      row("a1", "assistant", "[Response cancelled by user]", "interrupted"),
      row("u2", "user", "again"),
      row("a2", "assistant", "calc.py adds\n\n[Response cancelled by user]", "interrupted"),
    ] as never);
    expect(ui[1]).toMatchObject({ content: "", interrupted: true });
    expect(ui[3]).toMatchObject({ content: "calc.py adds", interrupted: true });
  });
});

describe("a reply stopped live", () => {
  const msg = (id: number, role: "user" | "assistant", content: string) =>
    ({ id, role, content, chatId: 1 }) as Message;

  it("is marked interrupted as soon as the turn ends", () => {
    const out = markStoppedReply([msg(1, "user", "hi"), msg(2, "assistant", "Hel")]);
    expect(out[1]).toMatchObject({ content: "Hel", interrupted: true });
  });

  it("leaves the chat alone when the stop came before any reply", () => {
    const before = [msg(1, "user", "hi")];
    expect(markStoppedReply(before)).toBe(before);
  });
});
