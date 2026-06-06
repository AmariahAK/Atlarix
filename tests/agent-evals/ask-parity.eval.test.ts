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
 * v12 0.1 — ASK-tier behavior on the unified runAgentTurn engine.
 *
 * Originally Phase A parity baselines pinned against the legacy ask loop;
 * single-leg (engine only) since the 0.1 close-out deleted the legacy bodies.
 *
 * Ask-tier facts these rely on (verified):
 * - singleRound profile: a completed round ends the turn — the AI-SDK inner
 *   loop handles tool multi-step within the round, so no <task_complete> is
 *   needed to end an ask turn;
 * - toolset = ToolRegistry.getToolsForAskMode() (isReadOnly || allowInAskMode)
 *   → write tools are NOT offered; plan-write tools union in for workMode
 *   "plan" (0.1 close-out fix);
 * - repetition guard (askAgenticRepetition) injects corrections mid-round
 *   (prepareStep) and aborts the in-flight stream on loop_abort
 *   (LOOP_REPETITION_STREAM_STOP);
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

    const requests = ctx.server.requestsFor(
      "ask-read-flow",
    ) as RecordedRequest[];
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

  it("plan workMode: plan-write tools are offered (v12 0.1 close-out fix)", async () => {
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

    const requests = ctx.server.requestsFor(
      "ask-plan-surface",
    ) as RecordedRequest[];
    const tools = offeredToolNames(requests[0]);
    expect(tools).toContain("read_file"); // read surface present in plan mode

    // FIXED defect (was pinned as a baseline): plan workMode routes through
    // the ask tier, whose toolset is getToolsForAskMode() — the plan-write
    // tools are isReadOnly:false + allowInAskMode:false, so they were never
    // offered even though PLAN_ALLOWLIST names them and the ask wrapper has
    // dedicated artifact handling. The toolset assembly now unions them in
    // when workMode === "plan".
    expect(tools).toContain("write_implementation_plan");
    expect(tools).toContain("update_plan_status");
    expect(tools).toContain("update_plan_step");
    // Still excluded outside plan mode (see the read-only flow eval above) —
    // and write/run tools stay out regardless.
    expect(tools).not.toContain("write_file");
    expect(tools).not.toContain("edit_file");
  });

  it("plan workMode: write_implementation_plan executes and emits the plan artifact", async () => {
    ctx.server.register(
      scenario("ask-plan-write")
        .toolCall("write_implementation_plan", {
          title: "Refactor plan",
          content:
            "# Refactor plan\n\n1. Extract the helper.\n2. Migrate call sites.",
        })
        .text("I wrote the implementation plan.")
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=ask-plan-write Write the refactor plan.",
      mode: "ask",
      settings: { workModePreference: "plan" },
    });

    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    // The shared ask wrapper's dedicated handling fired: "Plan saved"
    // activity + plan-artifact marker appended to the response.
    const activities = fakeIpc.sentOn("chat:activity");
    expect(
      activities.some((a) => a.payload?.label === "Plan saved"),
      "expected the wrapper's 'Plan saved' activity",
    ).toBe(true);

    const { getEphemeralChat } = await import("@/lib/ephemeral-chat");
    const lastAssistant = [...(getEphemeralChat(chatId)?.messages ?? [])]
      .reverse()
      .find((m) => m.role === "assistant");
    expect(lastAssistant?.content).toContain("atlarix-plan-artifact");
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

    const activities = fakeIpc
      .sentOn("chat:activity")
      .map((s) => s.payload?.type);
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
      scenario("ask-roundtrip").text("Persisted from ask mode.").build(),
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

  it("native history across ask turns: the engine emits the B2 envelope", async () => {
    // v12 0.1 Phase E: ask inherits 0.2's between-turns native history via
    // the engine (the shared tail persists rt.nativeTurnMessages). Single-leg
    // since the 0.1 close-out — the legacy ask loop (which never populated
    // the envelope) is deleted.
    ctx.server.register(
      scenario("ask-nh-1")
        .toolCall("read_file", { path: "src/info.ts" })
        .text("Turn one read the info file.")
        .build(),
    );
    ctx.server.register(scenario("ask-nh-2").text("Turn two recap.").build());

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

    // Engine: turn-1's native tool exchange replays in turn-2's history.
    expect(
      toolMsgs.length,
      "engine ask must replay turn-1's native role:'tool' message",
    ).toBeGreaterThanOrEqual(1);
    expect(
      assistantToolCallMsgs.length,
      "engine ask must replay turn-1's assistant tool_calls message",
    ).toBeGreaterThanOrEqual(1);
  });
});
