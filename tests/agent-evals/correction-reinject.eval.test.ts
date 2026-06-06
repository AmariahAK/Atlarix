import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectStreamEnded } from "../infra/assert";

/**
 * v12 0.1 close-out: mid-round correction reinject (prepareStep).
 *
 * Repetition corrections are queued by the tool wrappers INSIDE the AI-SDK
 * multi-step inner loop, where the engine's round-boundary injection can't
 * reach until the round ends — which a runaway model never lets happen.
 * `simpleStreamText` now passes a `prepareStep` hook that takes the pending
 * correction at the next step boundary and appends it as a user message to
 * THAT step's input, so the model is steered mid-round (strikes 1–2) before
 * the 3rd-strike hard abort.
 *
 * The injected message is step-input only — it must never appear in
 * `response.messages`, so the persisted B2 native-history envelope stays
 * byte-stable (transient steering nudge, not history).
 */

const CORRECTION_NEEDLE = "You appear to be repeating the same action";

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/loop.ts": "export const loop = true;\n" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

type RecordedRequest = {
  messages: Array<{ role: string; content?: unknown }>;
};

function requestsWithCorrection(scenarioId: string): RecordedRequest[] {
  return (ctx.server.requestsFor(scenarioId) as RecordedRequest[]).filter((r) =>
    r.messages.some(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes(CORRECTION_NEEDLE),
    ),
  );
}

describe("mid-round correction reinject", () => {
  it("build: the correction reaches the model mid-round before the abort", async () => {
    ctx.server.register(
      scenario("reinject-build")
        .toolCall("read_file", { path: "src/loop.ts" })
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=reinject-build What is in src/loop.ts?",
      mode: "build",
      timeoutMs: 20_000,
    });

    // Strikes 1–2 queued corrections; prepareStep delivered them as user
    // messages on subsequent steps of the SAME round (the runaway model
    // never reaches a round boundary).
    expect(
      requestsWithCorrection("reinject-build").length,
      "expected the repetition correction to appear in a model request mid-round",
    ).toBeGreaterThanOrEqual(1);

    // The 3rd strike still hard-aborts the stream.
    const activities = fakeIpc
      .sentOn("chat:activity")
      .map((s) => s.payload?.type);
    expect(activities).toContain("loop_detected");
    expect(activities).toContain("loop_repetition_aborted");
    expect(ctx.server.requestsFor("reinject-build").length).toBeLessThan(30);

    // B2 purity: the injected correction is step-input only — it must not
    // leak into the persisted native-history envelope.
    const endPayload = fakeIpc
      .sentOn("chat:response:end")
      .map((s) => s.payload)
      .find((p) => p?.assistantModelContent);
    if (endPayload?.assistantModelContent) {
      expect(endPayload.assistantModelContent).not.toContain(CORRECTION_NEEDLE);
    }

    expectStreamEnded(fakeIpc.sends, chatId);
  }, 30_000);

  it("ask: the correction reaches the model mid-round before the abort", async () => {
    ctx.server.register(
      scenario("reinject-ask")
        .toolCall("read_file", { path: "src/loop.ts" })
        .repeatLast()
        .build(),
    );

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=reinject-ask What is in src/loop.ts?",
      mode: "ask",
      timeoutMs: 20_000,
    });

    expect(
      requestsWithCorrection("reinject-ask").length,
      "expected the repetition correction to appear in a model request mid-round",
    ).toBeGreaterThanOrEqual(1);

    const activities = fakeIpc
      .sentOn("chat:activity")
      .map((s) => s.payload?.type);
    expect(activities).toContain("loop_detected");
    expect(activities).toContain("loop_repetition_aborted");
    expect(ctx.server.requestsFor("reinject-ask").length).toBeLessThan(30);

    expectStreamEnded(fakeIpc.sends, chatId);
  }, 30_000);
});
