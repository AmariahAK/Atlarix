import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  setupEvalContext,
  getIpcHandler,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import { writeTestSettings } from "../infra/settings";
import { makeFakeIpcEvent } from "../infra/ipc";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * v14.8.7 §A (deferred eval, now built) — supersede cascade.
 *
 * A second chat:stream dispatched for the SAME chat before the first finishes
 * must be handled by the single-flight guard (chat_stream_handlers ~1404-1420:
 * abort the prior leg with SUPERSEDED_STREAM_STOP, await it, then run the new
 * one). The new turn must complete cleanly — no crash, no deadlock, no double
 * terminal for the superseding turn.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/x.ts": "export const x = 1;\n" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("supersede cascade", () => {
  it("a superseding turn completes cleanly on the same chat", async () => {
    ctx.server.register(
      scenario("supersede-first")
        .toolCall("read_file", { path: "src/x.ts" })
        .text("First turn answer.")
        .repeatLast()
        .build(),
    );
    ctx.server.register(
      scenario("supersede-second").text("Second turn answer.").build(),
    );

    writeTestSettings({
      selectedChatMode: "build",
      workModePreference: "build",
      selectedModel: { name: ctx.modelName, provider: ctx.providerId },
      hasRunBefore: true,
      telemetryConsent: "opted_out",
    });

    const chatId = await ctx.newChat();
    const handler = await getIpcHandler("chat:stream");

    const fakeA = makeFakeIpcEvent();
    const fakeB = makeFakeIpcEvent();

    // Dispatch A (returns immediately; runStream continues in background)…
    await handler(fakeA.event, {
      chatId,
      prompt: "sc=supersede-first Do the first thing.",
    });
    // …then immediately supersede it with B on the SAME chat.
    await handler(fakeB.event, {
      chatId,
      prompt: "sc=supersede-second Actually, do this instead.",
    });

    // B must reach a clean terminal.
    await fakeB.waitFor(
      "chat:response:end",
      (p) => p?.chatId === chatId,
      25_000,
    );

    expectNoStreamError(fakeB.sends, chatId);
    expectStreamEnded(fakeB.sends, chatId);

    // The superseding turn produced its own answer.
    const bText = JSON.stringify(fakeB.sends);
    expect(bText).toContain("Second turn answer.");
  });
});
