import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import {
  expectToolSequence,
  expectNoStreamError,
  expectStreamEnded,
  expectDbSessionMessage,
} from "../infra/assert";

/**
 * v12 0.1 Phase A — ASK-tier parity baselines.
 *
 * These pin the CURRENT ask-loop behavior (chat_stream_handlers.ts ask branch)
 * BEFORE it migrates onto the unified runAgentTurn engine. After migration
 * they must stay green with the unified flag ON and OFF.
 *
 * Ask-loop facts these rely on (verified):
 * - one outer while(true); normal exit = !shouldContinue(finishReason) — the
 *   AI-SDK inner loop handles tool multi-step within a single round, so no
 *   <task_complete> is needed to end an ask turn;
 * - toolset = ToolRegistry.getToolsForAskMode() (isReadOnly || allowInAskMode)
 *   → write tools are NOT offered at all;
 * - repetition guard (askAgenticRepetition) aborts the in-flight stream on
 *   loop_abort (session-1 fix, LOOP_REPETITION_STREAM_STOP);
 * - ask_user → `user-question-request` event + ASK_USER_STREAM_STOP end-turn.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: {
      "src/info.ts": 'export const info = "habari";\n',
    },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

type RecordedRequest = {
  messages: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ function?: { name?: string } }>;
};

const offeredToolNames = (req: RecordedRequest): string[] =>
  (req.tools ?? [])
    .map((t) => t.function?.name)
    .filter((n): n is string => typeof n === "string");

describe("ask parity baselines", () => {
  it("read-only flow: read_file runs with workspace injection; write tools are not offered", async () => {
    ctx.server.register(
      scenario("ask-read-flow")
        .toolCall("read_file", { path: "src/info.ts" })
        .text("The info constant is habari.")
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=ask-read-flow What does src/info.ts export?",
      mode: "ask",
    });

    expectNoStreamError(fakeIpc.sends, chatId);
    expectToolSequence(fakeIpc.sends, ["read_file"]);

    const requests = ctx.server.requestsFor("ask-read-flow") as RecordedRequest[];
    expect(requests.length).toBeGreaterThanOrEqual(2);
    // Workspace injection: the tool actually read the seeded file.
    expect(JSON.stringify(requests[requests.length - 1])).toContain("habari");

    // Toolset surface: ask offers read/exploration tools only — write/run
    // tools are excluded at the getToolsForAskMode boundary.
    const tools = offeredToolNames(requests[0]);
    expect(tools).toContain("read_file");
    expect(tools).toContain("ask_user");
    expect(tools).not.toContain("write_file");
    expect(tools).not.toContain("edit_file");
    expect(tools).not.toContain("write_multiple_files");

    expectStreamEnded(fakeIpc.sends, chatId);

    const { getEphemeralChat } = await import("@/lib/ephemeral-chat");
    const lastAssistant = [...(getEphemeralChat(chatId)?.messages ?? [])]
      .reverse()
      .find((m) => m.role === "assistant");
    expect(lastAssistant?.content).toContain("habari");
  });

  it("plan workMode: toolset surface baseline (suspected defect: plan tool not offered)", async () => {
    ctx.server.register(
      scenario("ask-plan-surface")
        .text("Here is my plan outline in prose.")
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=ask-plan-surface Plan the refactor.",
      mode: "ask",
      settings: { workModePreference: "plan" },
    });

    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const requests = ctx.server.requestsFor("ask-plan-surface") as RecordedRequest[];
    const tools = offeredToolNames(requests[0]);
    expect(tools).toContain("read_file"); // read surface present in plan mode

    // BASELINE of a SUSPECTED DEFECT: plan workMode routes through the ask
    // loop, whose toolset is getToolsForAskMode() — write_implementation_plan
    // has isReadOnly:false + allowInAskMode:false, so it is NOT offered even
    // though the ask wrapper has dedicated handling for it (L4487) and the
    // mode allowlist names it. Pinned here so the 0.1 migration makes a
    // CONSCIOUS decision (fix = profile-level plan-tool inclusion).
    expect(tools).not.toContain("write_implementation_plan");
  });

  it("repetition guard: repeated identical read aborts the stream (bounded)", async () => {
    ctx.server.register(
      scenario("ask-loop-read")
        .toolCall("read_file", { path: "src/info.ts" })
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=ask-loop-read Read the info file.",
      mode: "ask",
      timeoutMs: 20_000,
    });

    const activities = fakeIpc.sentOn("chat:activity").map((s) => s.payload?.type);
    expect(activities).toContain("loop_detected");
    expect(activities).toContain("loop_repetition_aborted");

    expect(ctx.server.requestsFor("ask-loop-read").length).toBeLessThan(30);
    expectStreamEnded(fakeIpc.sends, chatId);
  }, 30_000);

  it("ask_user ends the turn with a question event", async () => {
    ctx.server.register(
      scenario("ask-question")
        .toolCall("ask_user", {
          question: "Which module should I explain?",
          options: ["auth", "billing"],
        })
        .repeatLast() // turn should END at the question; no further steps served
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=ask-question Explain a module.",
      mode: "ask",
    });

    const questionEvents = fakeIpc.sentOn("user-question-request");
    expect(questionEvents.length).toBe(1);
    expect(questionEvents[0].payload.question).toBe(
      "Which module should I explain?",
    );
    expect(questionEvents[0].payload.questions).toHaveLength(1);

    // Turn ended at the question — the model was never re-dispatched.
    expect(ctx.server.requestsFor("ask-question").length).toBe(1);
    expectStreamEnded(fakeIpc.sends, chatId);
  });

  it("round-trip: ask turn persists user message + ephemeral assistant", async () => {
    ctx.server.register(
      scenario("ask-roundtrip")
        .text("Persisted from ask mode.")
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=ask-roundtrip Say something persistent.",
      mode: "ask",
    });

    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    await expectDbSessionMessage(ctx.testDb, {
      role: "user",
      contentContains: "Say something persistent.",
    });

    const { getEphemeralChat } = await import("@/lib/ephemeral-chat");
    const lastAssistant = [...(getEphemeralChat(chatId)?.messages ?? [])]
      .reverse()
      .find((m) => m.role === "assistant");
    expect(lastAssistant?.content).toContain("Persisted from ask mode.");
  });

  it("native history across ask turns: engine emits the B2 envelope; legacy does not", async () => {
    // v12 0.1 Phase E: ask inherits 0.2's between-turns native history VIA
    // THE ENGINE (the shared tail persists rt.nativeTurnMessages — the legacy
    // ask loop never populates it). The suite runs flag ON and OFF, so this
    // pins BOTH behaviors explicitly.
    ctx.server.register(
      scenario("ask-nh-1")
        .toolCall("read_file", { path: "src/info.ts" })
        .text("Turn one read the info file.")
        .build(),
    );
    ctx.server.register(
      scenario("ask-nh-2").text("Turn two recap.").build(),
    );

    const chatId = await ctx.newChat();
    const turn1 = await runTurn(ctx, {
      chatId,
      prompt: "sc=ask-nh-1 Read src/info.ts.",
      mode: "ask",
    });
    expectNoStreamError(turn1.fakeIpc.sends, chatId);

    const turn2 = await runTurn(ctx, {
      chatId,
      prompt: "sc=ask-nh-2 Recap what you found.",
      mode: "ask",
    });
    expectNoStreamError(turn2.fakeIpc.sends, chatId);
    expectStreamEnded(turn2.fakeIpc.sends, chatId);

    const turn2Req = (
      ctx.server.requestsFor("ask-nh-2") as Array<{
        messages: Array<{
          role: string;
          tool_calls?: Array<{ function?: { name?: string } }>;
        }>;
      }>
    )[0];
    const toolMsgs = turn2Req.messages.filter((m) => m.role === "tool");
    const assistantToolCallMsgs = turn2Req.messages.filter(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.length > 0,
    );

    if (process.env.ATLARIX_UNIFIED_LOOP === "1") {
      // Engine: turn-1's native tool exchange replays in turn-2's history.
      expect(
        toolMsgs.length,
        "engine ask must replay turn-1's native role:'tool' message",
      ).toBeGreaterThanOrEqual(1);
      expect(
        assistantToolCallMsgs.length,
        "engine ask must replay turn-1's assistant tool_calls message",
      ).toBeGreaterThanOrEqual(1);
    } else {
      // Legacy ask loop: no envelope — turn 2 sees prose history only.
      expect(toolMsgs.length).toBe(0);
      expect(assistantToolCallMsgs.length).toBe(0);
    }
  });
});
