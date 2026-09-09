import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";

/**
 * Debug is a BUILD-class mode and must get the build turn runner.
 *
 * The selector used to read `settings.selectedChatMode === "ask"`, and
 * `chatModeForWorkMode` maps everything except `build` to "ask" — so debug ran
 * through the ask branch, which sets `singleRound: true`. It kept the SDK's inner
 * multi-step loop but lost the OUTER agentic loop and the completion gates, while
 * three places in the codebase said the opposite: `mode-tool-registry` ("debug =
 * full surface, differs from build by prompt discipline only"), `isReadOnlyWorkMode`
 * (debug is not read-only), and `run-agent-turn` ("Build/debug: run the completion
 * gates before ending").
 *
 * **The assertions are COMPARATIVE on purpose.** An absolute round or request count
 * would pin how the harness happens to batch a round today, and would go green for
 * the wrong reason the moment that changed. What matters is the relationship: debug
 * behaves like build, and unlike ask. That holds whatever the absolute numbers are.
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

/**
 * One tool round, then prose — enough for the outer loop to report an iteration.
 */
function toolThenProse(id: string) {
  return scenario(id)
    .toolCall("read_file", { path: "src/x.ts" })
    .text("All done.")
    .text("All done.")
    .repeatLast()
    .build();
}

/**
 * The discriminator, found by diffing the IPC channels of the two branches on an
 * identical scenario rather than by guessing: **only the build branch emits
 * `chat:iteration:progress`.** That is the outer agentic loop reporting itself — the
 * exact thing `singleRound: true` denies the ask branch, and the exact thing debug
 * was missing.
 *
 * Request counts were tried first and are useless here: ask and build both made 2 on
 * this scenario, so counting would have produced a test that passes either way. The
 * sanity guard below exists so that can never silently happen again.
 */
const OUTER_LOOP_CHANNEL = "chat:iteration:progress";

async function ranOuterLoop(
  workMode: "ask" | "debug" | "build",
): Promise<boolean> {
  const id = `route-${workMode}`;
  ctx.server.register(toolThenProse(id));
  const chatId = await ctx.newChat();
  const turn = await runTurn(ctx, {
    chatId,
    prompt: `sc=${id} Look at src/x.ts.`,
    // The harness settings shape only takes ask|build|agent; the WORK mode is what
    // the selector reads, and it is set explicitly below.
    mode: workMode === "ask" ? "ask" : "build",
    settings: {
      workModePreference: workMode,
      // Deliberately left at "ask" for debug — exactly the persisted state a real
      // user on Debug has, and the state a mapping-only fix would have ignored.
      selectedChatMode: workMode === "build" ? "build" : "ask",
      intentMode: workMode === "build" ? "build" : "ask",
    },
    timeoutMs: 40_000,
  });
  return (turn.fakeIpc.sends as Array<{ channel?: string }>).some(
    (s) => s.channel === OUTER_LOOP_CHANNEL,
  );
}

describe("debug mode is routed like build, not like ask", () => {
  it("gives debug the build runner's outer loop, which ask never gets", async () => {
    const ask = await ranOuterLoop("ask");
    const build = await ranOuterLoop("build");
    const debug = await ranOuterLoop("debug");

    // Sanity FIRST: the signal has to separate the two branches, or everything
    // below is vacuous and would pass with the fix reverted.
    expect(
      { ask, build },
      `${OUTER_LOOP_CHANNEL} does not distinguish the branches — this test would prove nothing`,
    ).toEqual({ ask: false, build: true });

    expect(debug, "debug must run the outer agentic loop, like build").toBe(
      true,
    );
    expect(debug, "debug must not be single-round, like ask").not.toBe(ask);
  });

  /**
   * Debug keeps its own identity while taking build's runner: the mode block is
   * keyed on the work mode, so it must still say Debug rather than Build. Routing
   * changed; the prompt discipline that distinguishes them did not.
   */
  it("still presents as Debug, not Build", async () => {
    const id = "route-identity";
    ctx.server.register(scenario(id).text("Done.").repeatLast().build());
    const chatId = await ctx.newChat();
    await runTurn(ctx, {
      chatId,
      prompt: `sc=${id} hi`,
      mode: "build",
      settings: {
        workModePreference: "debug",
        selectedChatMode: "ask",
        intentMode: "ask",
      },
      timeoutMs: 30_000,
    });

    const system = JSON.stringify(ctx.server.requestsFor(id)[0]);
    expect(system).toMatch(/Debug/);
  });
});
