import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  setupEvalContext,
  runTurn,
  type EvalContext,
} from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";

/**
 * v12 S18 — the six pre-flight context loads run CONCURRENTLY (Promise.all)
 * but assembly must stay deterministic: every section still lands in the
 * dispatched system prompt, and section ORDER (ContextAssembler's priority
 * sort) is identical across turns — the prompt-cache stability guard.
 */

let ctx: EvalContext;

const MEMORY_CANARY = "ATLX-S18-MEMORY-CANARY: this repo prefers tabs.";

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: {
      "src/app.ts": "export const app = 1;\n",
      ".atlarix/atlarix.md": `${MEMORY_CANARY}\n`,
    },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

/** All system-message content of the FIRST recorded request, concatenated. */
function firstRequestSystemBlob(scenarioId: string): string {
  const requests = ctx.server.requestsFor(scenarioId) as Array<{
    messages: Array<{ role: string; content?: unknown }>;
  }>;
  expect(requests.length).toBeGreaterThanOrEqual(1);
  return requests[0]!.messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

describe("context assembly under concurrent pre-flight (S18)", () => {
  it("a build turn carries the concurrently-loaded sections in priority order", async () => {
    ctx.server.register(
      scenario("s18-assembly-1").text("ok <task_complete>").build(),
    );
    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=s18-assembly-1 What does this repo prefer?",
      mode: "build",
    });
    expectNoStreamError(fakeIpc.sends, chatId);
    expectStreamEnded(fakeIpc.sends, chatId);

    const sys = firstRequestSystemBlob("s18-assembly-1");
    // The two sections every workspace build turn must carry.
    const skillIdx = sys.indexOf("Active Skill");
    const memoryIdx = sys.indexOf(MEMORY_CANARY);
    expect(skillIdx).toBeGreaterThanOrEqual(0); // mode skill loaded
    expect(memoryIdx).toBeGreaterThanOrEqual(0); // atlarix.md loaded
    expect(sys).toContain("Project memory (.atlarix/atlarix.md)");
    // Priority order survives the Promise.all: activeSkill (-1) renders
    // before projectMemory (4).
    expect(skillIdx).toBeLessThan(memoryIdx);
  }, 30_000);

  it("section presence and order are identical on a second fresh chat (determinism)", async () => {
    ctx.server.register(
      scenario("s18-assembly-2").text("ok <task_complete>").build(),
    );
    const chatId = await ctx.newChat();
    const { fakeIpc } = await runTurn(ctx, {
      chatId,
      prompt: "sc=s18-assembly-2 What does this repo prefer?",
      mode: "build",
    });
    expectNoStreamError(fakeIpc.sends, chatId);

    const sys1 = firstRequestSystemBlob("s18-assembly-1");
    const sys2 = firstRequestSystemBlob("s18-assembly-2");
    const markers = ["Active Skill", "Project memory (.atlarix/atlarix.md)"];
    const order = (s: string) =>
      markers
        .map((m) => [m, s.indexOf(m)] as const)
        .filter(([, i]) => i >= 0)
        .sort((a, b) => a[1] - b[1])
        .map(([m]) => m);
    expect(order(sys2)).toEqual(order(sys1));
    expect(order(sys2)).toHaveLength(markers.length);
  }, 30_000);
});
