import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import {
  expectToolSequence,
  expectStreamEnded,
  expectNoStreamError,
} from "../infra/assert";

/**
 * Eval 1 (Tier 4): single-tool flow — Build mode (the primary loop).
 *
 * The model (scripted) calls read_file on a seeded workspace file, then
 * finishes with a prose-only round. Asserts the REAL stream loop end-to-end:
 * native tool_call parsing → ToolRegistry execution with workspace injection →
 * tool result returned to the model → final text → stream end + ephemeral
 * history updated.
 *
 * NOTE: the harness originally exposed that selectedChatMode "agent" ran the
 * agent loop AND THEN fell into the build loop (double-dispatch) with no
 * `workspace` arg injection. v12 0.1 Phase D DELETED that path; legacy
 * "agent" now coerces to "build" — pinned in agent-mode-coercion.eval.test.ts.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: {
      "src/greeting.ts": 'export const greeting = "salama";\n',
    },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("single-tool flow (build mode)", () => {
  it("reads a file then completes", async () => {
    ctx.server.register(
      scenario("single-read")
        .toolCall("read_file", { path: "src/greeting.ts" })
        .text("The greeting is salama.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=single-read What does src/greeting.ts export?",
      mode: "build",
    });

    // Errors first — they explain everything downstream.
    expectNoStreamError(fakeIpc.sends, chatId);

    // Tool sequence: exactly one read_file
    expectToolSequence(fakeIpc.sends, ["read_file"]);

    // The tool actually executed against the real workspace: the model's
    // follow-up request carries the real file content.
    const requests = ctx.server.requestsFor("single-read") as any[];
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(requests[requests.length - 1])).toContain("salama");

    // Turn terminated cleanly
    expectStreamEnded(fakeIpc.sends, chatId);

    // Final assistant message in ephemeral history.
    const { getStreamTransport } = await import("@/lib/chat/stream-transport");
    const chat = getStreamTransport(chatId);
    const lastAssistant = [...(chat?.messages ?? [])]
      .reverse()
      .find((m) => m.role === "assistant");
    expect(lastAssistant?.content).toContain("The greeting is salama.");
  });
});
