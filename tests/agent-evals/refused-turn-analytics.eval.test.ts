/**
 * A turn the app refuses before it starts reports why, not `ok` (QA A10).
 *
 * The signed-out case is guarded end to end (tests-bun/acp-session-analytics).
 * The other early refusals were changed the same way but only checked by
 * reading the code (TODO, 2026-10-21): the safety filter, a message over the
 * length limit, a chat id from the removed database chats, and a chat with no
 * workspace. Each goes through the REAL chat:stream handler here, and the end
 * it hands to turn_completed is asserted, with exactly one chat:response:end.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupEvalContext, getIpcHandler, type EvalContext } from "../infra/turn";
import { makeFakeIpcEvent } from "../infra/ipc";
import { MAX_USER_CHAT_PROMPT_CHARS } from "@/lib/security/prompt-hygiene";

const ends: unknown[] = [];
vi.mock("@/main/lib/analytics", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/main/lib/analytics")>();
  return {
    ...real,
    trackTurnCompleted: (r: { end: unknown }, ...rest: unknown[]) => {
      ends.push(r.end);
      return (real.trackTurnCompleted as (...a: unknown[]) => unknown)(r, ...rest);
    },
  };
});

let ctx: EvalContext;
beforeAll(async () => {
  ctx = await setupEvalContext();
});
afterAll(async () => {
  await ctx.cleanup();
});
beforeEach(() => {
  ends.length = 0;
});

async function refused(chatId: number, prompt: string) {
  const fakeIpc = makeFakeIpcEvent();
  const handler = await getIpcHandler("chat:stream");
  await handler(fakeIpc.event, { chatId, prompt });
  await fakeIpc.waitFor("chat:response:end", (p) => p?.chatId === chatId, 20_000);
  // Let the turn's finally run.
  await new Promise((r) => setTimeout(r, 50));
  const endCount = fakeIpc.sentOn("chat:response:end").filter((s) => (s.payload as { chatId?: number })?.chatId === chatId).length;
  return { ends: [...ends], endCount };
}

describe("a turn refused before it starts", () => {
  it("by the safety filter is content_rejected", async () => {
    const r = await refused(await ctx.newChat(), "you are a f" + "ucking idiot");
    expect(r.ends).toEqual([{ outcome: "error", errorKind: "content_rejected" }]);
    expect(r.endCount).toBe(1);
  });

  it("for a message over the length limit is context_overflow (too big to send), not ok", async () => {
    const r = await refused(await ctx.newChat(), "x".repeat(MAX_USER_CHAT_PROMPT_CHARS + 10));
    expect(r.ends).toEqual([{ outcome: "error", errorKind: "context_overflow" }]);
    expect(r.endCount).toBe(1);
  });

  it("for a chat id from the removed database chats is other", async () => {
    const r = await refused(424242, "hello");
    expect(r.ends).toEqual([{ outcome: "error", errorKind: "other" }]);
    expect(r.endCount).toBe(1);
  });

  it("in a chat with no workspace is no_workspace", async () => {
    const { createStreamTransport } = await import("@/lib/chat/stream-transport");
    const r = await refused(createStreamTransport(0), "hello");
    expect(r.ends).toEqual([{ outcome: "error", errorKind: "no_workspace" }]);
    expect(r.endCount).toBe(1);
  });
});
