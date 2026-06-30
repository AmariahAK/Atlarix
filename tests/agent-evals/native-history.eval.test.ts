import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * v12 0.2 — native tool-call history evals (build mode).
 *
 * Written RED-first: they pin the target behavior of phases B1/B2.
 *
 * B1 (in-turn): after a build-loop round that executed NATIVE tools, the next
 * outer iteration must re-enter streamText with the round's native messages
 * (assistant tool_calls + role:"tool" results) — not the stripped-prose
 * assistant push (chat_stream_handlers.ts ~L6219).
 *
 * B2 (between-turns): turn N+1's dispatch must carry turn N's native tool
 * messages (assistant modelContent envelope), not atlarix-XML-stripped prose.
 *
 * The fake server speaks OpenAI protocol, so native history serializes as
 * assistant messages with `tool_calls` and `role:"tool"` result messages —
 * both directly assertable on the recorded request bodies.
 */

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: {
      "src/data.ts": "export const dataValue = 7;\n",
    },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

type RecordedRequest = {
  messages: Array<{
    role: string;
    content?: unknown;
    tool_calls?: Array<{ function?: { name?: string } }>;
  }>;
};

const toolMessagesOf = (req: RecordedRequest) =>
  (req.messages ?? []).filter((m) => m.role === "tool");
const assistantToolCallMessagesOf = (req: RecordedRequest) =>
  (req.messages ?? []).filter(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0,
  );

describe("native tool-call history", () => {
  it("B1: the post-tool step carries native tool parts, not prose", async () => {
    ctx.server.register(
      scenario("native-multi-round")
        // ONE streamText call, multi-step INTERNALLY (execute-based tools): a
        // native tool_call step, then the model's final text step. The step-2
        // request (sent after read_file executed) is the one under test — it
        // must carry the native tool exchange. The turn then ends on the
        // model's finishReason:"stop" (no needless extra outer iteration — that
        // was the old `roundHadNativeToolMessages` over-loop bug).
        .toolCall("read_file", { path: "src/data.ts" })
        .text("Analysis complete. The data value is 7.")
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=native-multi-round What is the data value?",
      mode: "build",
    });

    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const requests = ctx.server.requestsFor(
      "native-multi-round",
    ) as RecordedRequest[];
    // req1 = tool_call step; req2 = the post-execute text step, which carries
    // the assistant tool_calls + role:"tool" result natively.
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const postTool = requests[requests.length - 1];

    // Target: the post-tool step's history carries the native tool exchange…
    expect(
      toolMessagesOf(postTool).length,
      "post-tool request must contain a native role:'tool' message",
    ).toBeGreaterThanOrEqual(1);
    expect(
      assistantToolCallMessagesOf(postTool).length,
      "post-tool request must contain the assistant tool_calls message",
    ).toBeGreaterThanOrEqual(1);

    // …and NOT the synthetic flattening.
    expect(JSON.stringify(postTool)).not.toContain(
      "Here are the results of the tools you called",
    );
  });

  it("B2: turn 2 carries turn 1's native tool parts across turns", async () => {
    ctx.server.register(
      scenario("native-2turn-a")
        .toolCall("read_file", { path: "src/data.ts" })
        .text("The data value is 7.")
        .repeatLast()
        .build(),
    );
    ctx.server.register(
      scenario("native-2turn-b")
        .text("Recap: the value was 7.")
        .build(),
    );

    const chatId = await ctx.newChat();

    const turn1 = await runTurn(ctx, {
      chatId,
      prompt: "sc=native-2turn-a Read src/data.ts and report the value.",
      mode: "build",
    });
    expectNoStreamError(turn1.fakeIpc.sends, chatId);

    const turn2 = await runTurn(ctx, {
      chatId,
      prompt: "sc=native-2turn-b Recap what you found.",
      mode: "build",
    });
    expectNoStreamError(turn2.fakeIpc.sends, chatId);
    expectStreamEnded(turn2.fakeIpc.sends, chatId);

    const turn2Requests = ctx.server.requestsFor(
      "native-2turn-b",
    ) as RecordedRequest[];
    expect(turn2Requests.length).toBeGreaterThanOrEqual(1);
    const turn2Req = turn2Requests[0];

    // Target: turn-1's native tool exchange is in turn-2's history.
    expect(
      toolMessagesOf(turn2Req).length,
      "turn-2 request must contain turn-1's native role:'tool' message",
    ).toBeGreaterThanOrEqual(1);
    expect(
      assistantToolCallMessagesOf(turn2Req).length,
      "turn-2 request must contain turn-1's assistant tool_calls message",
    ).toBeGreaterThanOrEqual(1);

    // No atlarix-XML prose leaking into the model history.
    expect(JSON.stringify(turn2Req)).not.toContain("atlarix-tool-result");

    // Cache-eligibility: the native tool message in turn 2 is byte-identical
    // to the one turn 1's own follow-up request carried (stable history).
    const turn1Requests = ctx.server.requestsFor(
      "native-2turn-a",
    ) as RecordedRequest[];
    const turn1Tool = toolMessagesOf(
      turn1Requests[turn1Requests.length - 1],
    )[0];
    const turn2Tool = toolMessagesOf(turn2Req)[0];
    expect(turn1Tool).toBeTruthy();
    expect(JSON.stringify(turn2Tool?.content)).toEqual(
      JSON.stringify(turn1Tool?.content),
    );
  });

  it("B2 reload: native history survives session persist + rehydrate", async () => {
    ctx.server.register(
      scenario("native-reload-a")
        .toolCall("read_file", { path: "src/data.ts" })
        .text("Read it — the value is 7.")
        .repeatLast()
        .build(),
    );
    ctx.server.register(
      scenario("native-reload-b").text("Still 7.").build(),
    );

    const { getIpcHandler } = await import("../infra/turn");
    const chatId = await ctx.newChat();

    const turn1 = await runTurn(ctx, {
      chatId,
      prompt: "sc=native-reload-a Read src/data.ts.",
      mode: "build",
    });
    expectNoStreamError(turn1.fakeIpc.sends, chatId);

    // The end payload carries the envelope for the renderer…
    const endPayload = turn1.fakeIpc
      .sentOn("chat:response:end")
      .map((s) => s.payload)
      .find((p) => p?.assistantModelContent);
    expect(endPayload?.assistantModelContent).toContain(
      '"kind":"native-history"',
    );

    // …which the renderer persists via messages:add extras (played here).
    const { getStreamTransport, hydrateStreamTransport } = await import(
      "@/lib/chat/stream-transport"
    );
    const liveAssistant = (getStreamTransport(chatId)?.messages ?? []).find(
      (m) => m.role === "assistant",
    );
    const sessionRow = await ctx.testDb.db.query.chatSessions.findFirst({
      where: (s: any, { eq }: any) => eq(s.streamChatId, chatId),
    });
    // (Cast: the IPC handler signature is variadic at runtime.)
    const messagesAdd = (await getIpcHandler("messages:add")) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    await messagesAdd(
      {},
      sessionRow!.id,
      "assistant",
      liveAssistant!.content,
      undefined,
      {
        modelContent: endPayload!.assistantModelContent,
      },
    );

    // Simulated app restart: fresh transport hydrated from the session DB.
    const sessionsGet = await getIpcHandler("sessions:get");
    const loaded: any = await sessionsGet({} as any, sessionRow!.id);
    const reloadedChatId = await ctx.newChat();
    hydrateStreamTransport(
      reloadedChatId,
      loaded.messages.map((m: any) => ({
        role: m.role,
        content: m.content,
        modelContent: m.modelContent,
      })),
    );

    const turn2 = await runTurn(ctx, {
      chatId: reloadedChatId,
      prompt: "sc=native-reload-b What was the value?",
      mode: "build",
    });
    expectNoStreamError(turn2.fakeIpc.sends, reloadedChatId);

    const turn2Req = (
      ctx.server.requestsFor("native-reload-b") as RecordedRequest[]
    )[0];
    expect(
      toolMessagesOf(turn2Req).length,
      "reloaded turn must replay turn-1's native role:'tool' message",
    ).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(turn2Req)).not.toContain("atlarix-tool-result");
  });

  // The forced-text-tool path (weak/local-model fallback) now settles cleanly
  // under natural termination: text-tool detection runs on each iteration's
  // DELTA, so a prior round's `<tool_call>` is not re-detected/re-executed every
  // round (which previously looped until the scenario exhausted). The synthetic
  // XML tool-results message is still preserved as the text-tool feedback channel.
  it("negative control: text-tool fallback keeps the synthetic XML path", async () => {
    // The eval provider is custom (builtinProviderId undefined), which turns
    // the text-tool fallback OFF (shouldUseTextToolFallback). Force it on —
    // this control plays a weak/local model emitting XML tool calls.
    process.env.ATLARIX_FORCE_TEXT_TOOLS = "1";

    ctx.server.register(
      scenario("text-tool-fallback")
        // The MODEL emits a text-based tool call (weak/local-model fallback).
        .text(
          'I will read the data file.\n<tool_call name="read_file">{"path": "src/data.ts"}</tool_call>',
        )
        // Terminal prose rounds (no repeatLast — repeating the tool-call round
        // would re-run read_file forever). Natural termination + the text-tool
        // path takes a couple of reconciling prose rounds (bounded by the
        // PROSE_YIELD_MAX_NUDGES cap) before ending; script enough to cover them.
        .text("Done reading. The value is 7.")
        .text("The value is 7.")
        .text("The value is 7.")
        .text("The value is 7.")
        .build(),
    );

    const chatId = await ctx.newChat();
    let fakeIpc;
    try {
      ({ fakeIpc } = await runTurn(ctx, {
        chatId,
        prompt: "sc=text-tool-fallback What is the data value?",
        mode: "build",
      }));
    } finally {
      delete process.env.ATLARIX_FORCE_TEXT_TOOLS;
    }

    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const requests = ctx.server.requestsFor(
      "text-tool-fallback",
    ) as RecordedRequest[];
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const followUp = requests[requests.length - 1];

    // Parity: the synthetic tool-results user message MUST remain for
    // text-tool models (their only feedback channel).
    expect(JSON.stringify(followUp)).toContain(
      "Here are the results of the tools you called",
    );
    expect(JSON.stringify(followUp)).toContain("dataValue = 7");
  });

  it("v13 legacy compat: a hallucinated call to a DELETED tool returns a graceful error, never a crash", async () => {
    // explore_folder was removed in the v13 tool consolidation. Old sessions
    // (and stale model habits) may still emit it — the turn must survive with
    // a structured "Tool not found" result feeding back to the model.
    ctx.server.register(
      scenario("native-deleted-tool")
        .toolCall("explore_folder", { path: "." })
        .text("Understood — using glob instead.")
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=native-deleted-tool Map the repo.",
      mode: "build",
    });

    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const requests = ctx.server.requestsFor(
      "native-deleted-tool",
    ) as RecordedRequest[];
    const last = requests[requests.length - 1];
    expect(JSON.stringify(last)).toContain("unavailable tool");
    expect(JSON.stringify(last)).toContain("Available tools:");
  });
});
