/**
 * A2 — park + auto-resume + re-park.
 *
 * When the model would end the turn but background work is still outstanding,
 * runAgentTurn now ENDS the turn cleanly and marks it `parked` (instead of
 * holding the stream open with a poll loop). A fresh turn auto-resumes when an
 * item reports; its result drains in via the next turn's context section.
 *
 * The renderer auto-wake (useStreamChat) is what starts the resume turn in the
 * app; the backend harness has no renderer, so here we drive each resume turn
 * directly and assert the ENGINE behavior: parked-on-outstanding-work, the
 * result draining into the resumed turn, re-park while others remain, and a
 * final clean (parked:false) end once nothing is pending.
 *
 * We drive the sub-agent registry directly (recordSubagentStart/Result) so the
 * test is deterministic — it exercises the park decision, not sub-agent spawn
 * timing (which A0 + spawn-task cover).
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupEvalContext, runTurn, type EvalContext } from "../infra/turn";
import { scenario } from "../infra/scenario";
import { expectNoStreamError, expectStreamEnded } from "../infra/assert";
import type { RecordedSend } from "../infra/ipc";
import {
  recordSubagentStart,
  recordSubagentResult,
  clearSubagentsForChat,
} from "@/lib/agents/subagent-results";

let ctx: EvalContext;

beforeAll(async () => {
  ctx = await setupEvalContext({
    seedFiles: { "src/app.ts": "export const app = 1;\n" },
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

/** Did any chat:response:end for this chat carry parked === expected? */
function parkedOnEnd(
  sends: RecordedSend[],
  chatId: number,
  expected: boolean,
): boolean {
  const ends = sends.filter(
    (s) => s.channel === "chat:response:end" && s.payload?.chatId === chatId,
  );
  expect(
    ends.length,
    "expected at least one chat:response:end",
  ).toBeGreaterThanOrEqual(1);
  // parked omitted === false; any end carrying parked:true means parked.
  const anyParked = ends.some((e) => e.payload?.parked === true);
  return anyParked === expected;
}

describe("park + auto-resume (A2)", () => {
  it("parks on outstanding sub-agents, delivers each result on resume, re-parks, then ends clean", async () => {
    const chatId = await ctx.newChat();
    clearSubagentsForChat(chatId);

    // Two sub-agents 'running' (as if the model spawned them background:true).
    recordSubagentStart(chatId, "t1");
    recordSubagentStart(chatId, "t2");

    // Turn 1: model finishes its own work and signals done — but both
    // sub-agents are still running, so the turn must PARK (end, not hang).
    ctx.server.register(
      scenario("park-1").text("Spawned the scouts; my part is done.").build(),
    );
    const turn1 = await runTurn(ctx, {
      chatId,
      prompt: "sc=park-1 Kick off the research.",
      mode: "build",
    });
    expectNoStreamError(turn1.fakeIpc.sends, chatId);
    expectStreamEnded(turn1.fakeIpc.sends, chatId);
    expect(parkedOnEnd(turn1.fakeIpc.sends, chatId, true)).toBe(true);

    // t1 reports — one result pending, t2 still running.
    recordSubagentResult(chatId, "t1", {
      description: "scout one",
      state: "completed",
      body: "FIRST-PARK-MARKER",
      durationMs: 1000,
    });

    // Turn 2 (the auto-resume): the result drains into context; the model
    // comments and signals done — but t2 is still running, so it RE-PARKS.
    ctx.server.register(
      scenario("park-2").text("Got the first scout. Still waiting.").build(),
    );
    const turn2 = await runTurn(ctx, {
      chatId,
      prompt: "sc=park-2 Anything back yet?",
      mode: "build",
    });
    expectNoStreamError(turn2.fakeIpc.sends, chatId);
    const body2 = JSON.stringify(ctx.server.requestsFor("park-2")[0]);
    expect(body2).toContain("[Background sub-agent results]");
    expect(body2).toContain("FIRST-PARK-MARKER");
    expect(parkedOnEnd(turn2.fakeIpc.sends, chatId, true)).toBe(true);

    // t2 reports — last one; nothing left running.
    recordSubagentResult(chatId, "t2", {
      description: "scout two",
      state: "completed",
      body: "SECOND-PARK-MARKER",
      durationMs: 1000,
    });

    // Turn 3 (final resume): the last result drains; nothing is pending, so the
    // turn ends CLEAN (parked:false).
    ctx.server.register(
      scenario("park-3").text("Both scouts in — done for real.").build(),
    );
    const turn3 = await runTurn(ctx, {
      chatId,
      prompt: "sc=park-3 And now?",
      mode: "build",
    });
    expectNoStreamError(turn3.fakeIpc.sends, chatId);
    const body3 = JSON.stringify(ctx.server.requestsFor("park-3")[0]);
    expect(body3).toContain("SECOND-PARK-MARKER");
    expect(parkedOnEnd(turn3.fakeIpc.sends, chatId, false)).toBe(true);

    clearSubagentsForChat(chatId);
  }, 60_000);
});
