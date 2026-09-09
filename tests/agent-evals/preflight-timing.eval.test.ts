import { describe, expect, it, beforeAll, afterAll } from "vitest";
import log from "electron-log";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * v12 S17 — the TTFT pre-flight waterfall. A real build turn must emit ONE
 * `[perf] preflight-breakdown` line at first dispatch carrying the per-step
 * spans. This is the presence gate (instrumentation can't silently rot);
 * wall-clock thresholds are environment-dependent and live in the manual
 * release checklist, not here.
 */

let ctx: EvalContext;
const perfLines: string[] = [];

// electron-log invokes hooks once PER TRANSPORT (console + file) — key off one
// transport so each emitted line is collected exactly once.
const hook = (
  message: { data: unknown[] },
  _transport: unknown,
  transportName?: string,
) => {
  if (transportName === "console") {
    const text = message.data.map(String).join(" ");
    if (text.includes("[perf]")) perfLines.push(text);
  }
  return message as never;
};

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/app.ts": "export const app = 1;\n" },
  });
  log.hooks.push(hook as never);
});

afterAll(async () => {
  const i = log.hooks.indexOf(hook as never);
  if (i >= 0) log.hooks.splice(i, 1);
  await ctx.cleanup();
});

describe("preflight timing (S17)", () => {
  it("a build turn emits the preflight-breakdown waterfall at first dispatch", async () => {
    ctx.server.register(scenario("perf-waterfall").text("All good.").build());

    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=perf-waterfall Say hi.",
      mode: "build",
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const breakdowns = perfLines.filter((l) =>
      l.includes(`preflight-breakdown chat=${chatId}`),
    );
    // Exactly one per turn — simpleStreamText runs per round, but only the
    // FIRST dispatch is TTFT.
    expect(breakdowns).toHaveLength(1);
    const line = breakdowns[0]!;
    // The steps every workspace build turn must account for.
    for (const span of [
      "total=",
      "session-bind=",
      "model-client=",
      "context-window=",
      "mode-skill=",
      "prompt-bundle=",
    ]) {
      expect(line).toContain(span);
    }
  }, 30_000);
});
