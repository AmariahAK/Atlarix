/**
 * The round stops MID-FAN-OUT, which is the case a naive implementation gets wrong.
 *
 * Exhaustion at sub-task 1 is the easy shape: nothing has started, so almost any
 * guard happens to work. The real shape is exhaustion partway — the wallet covers
 * the first couple of children and refuses the third — and there the questions that
 * matter are whether the REMAINING children are stopped, and whether the model can
 * simply spawn more. Before this, both answers were no: cancelling touched neither
 * the per-turn count nor the dedupe set, so `task` stayed callable.
 *
 * This exercises the real `attachDelegationToolsToSet`, not a re-implementation of
 * its rules. The mocked `ToolRegistry.execute` stands in for the whole child stack
 * (task tool → spawn-task → runSubagent) and latches the halt the way `runSubagent`
 * does, from the frame that holds the raw 402.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";

const h = vi.hoisted(() => ({
  execute: vi.fn(),
  cancelAll: vi.fn(() => 0),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => ({ id: 1 }) },
}));

vi.mock("@/lib/tools/registry", () => ({
  ToolRegistry: {
    get: () => ({ description: "Delegate a task", parameters: {} }),
    execute: h.execute,
  },
}));

vi.mock("@/lib/tools/spawn-task", () => ({
  cancelAllSubagentTasksForChat: h.cancelAll,
}));

import { attachDelegationToolsToSet } from "@/lib/agents/register-delegation-tools";
import {
  __resetCreditHaltsForTests,
  markCreditExhausted,
} from "@/lib/agents/credit-halt";
import { MAX_SUBAGENTS_PER_TURN } from "@/lib/agents/agent-runtime";

const REFUSAL =
  "Your balance is used up. This turn needs at least $9.24 available.";

type Harness = {
  callTask: (n: number) => Promise<string>;
  started: () => number;
};

function harness(chatId: number): Harness {
  let delegationsStartedThisTurn = 0;
  const inFlight = new Set<string>();
  const tools: ToolSet = {};

  attachDelegationToolsToSet(tools, {
    sender: {} as never,
    chatId,
    effectiveWorkMode: "build",
    workspacePath: "/tmp/ws",
    turnId: `turn-${chatId}`,
    safeSend: () => {},
    getDelegationCount: () => delegationsStartedThisTurn,
    onDelegationStart: () => {
      delegationsStartedThisTurn += 1;
    },
    tryAcquireDedupeKey: (key) => {
      if (inFlight.has(key)) return false;
      inFlight.add(key);
      return true;
    },
    releaseDedupeKey: (key) => inFlight.delete(key),
  });

  return {
    callTask: (n: number) =>
      (
        tools.task!.execute as unknown as (
          a: Record<string, unknown>,
        ) => Promise<string>
      )({ subagent_type: "scout", prompt: `sub-task ${n}` }),
    started: () => delegationsStartedThisTurn,
  };
}

afterEach(() => {
  __resetCreditHaltsForTests();
  h.execute.mockReset();
  h.cancelAll.mockClear();
});

describe("a fan-out that runs out of credit at sub-task 3 of 5", () => {
  it("stops delegating, and says why rather than reporting N failed agents", async () => {
    const chatId = 8201;
    const { callTask, started } = harness(chatId);

    let child = 0;
    h.execute.mockImplementation(async () => {
      child += 1;
      if (child === 3) {
        // What `runSubagent` does when its stream's error part carries a 402.
        markCreditExhausted(chatId, REFUSAL);
        return `{"success":false,"error":${JSON.stringify(REFUSAL)}}`;
      }
      return `{"success":true,"result":"child ${child} done"}`;
    });

    const results: string[] = [];
    for (let n = 1; n <= MAX_SUBAGENTS_PER_TURN; n++) {
      results.push(await callTask(n));
    }

    // The two children after the refusal never reached the child stack at all.
    expect(h.execute).toHaveBeenCalledTimes(3);

    // And they were told the actual reason, not "maximum 5 sub-agents per turn" —
    // which would send the model off folding work into fewer prompts, advice that
    // cannot help an empty wallet.
    for (const r of results.slice(3)) {
      const parsed = JSON.parse(r) as { success: boolean; error?: string };
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe(REFUSAL);
    }

    // The two that ran before the refusal keep their results.
    expect(JSON.parse(results[0]!).success).toBe(true);
    expect(JSON.parse(results[1]!).success).toBe(true);

    // The turn count stopped climbing with the halt: a refused delegation must not
    // consume a slot the user paid nothing for.
    expect(started()).toBe(3);
  });

  it("cancels the children still running, with the credit reason not the Stop copy", async () => {
    const chatId = 8202;
    const { callTask } = harness(chatId);

    h.execute.mockImplementation(async () => {
      markCreditExhausted(chatId, REFUSAL);
      return `{"success":false,"error":${JSON.stringify(REFUSAL)}}`;
    });

    await callTask(1);

    // Passing the reason is the point: the default is "Cancelled by the user (turn
    // stopped)", which would have every cancelled sibling tell the model the user
    // interrupted — an interruption that never happened.
    expect(h.cancelAll).toHaveBeenCalledWith(chatId, REFUSAL);
  });

  it("refuses immediately once latched, without touching the child stack", async () => {
    const chatId = 8203;
    const { callTask } = harness(chatId);
    h.execute.mockResolvedValue('{"success":true}');

    markCreditExhausted(chatId, REFUSAL);
    const parsed = JSON.parse(await callTask(1)) as {
      success: boolean;
      error?: string;
    };

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe(REFUSAL);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("leaves a different chat's delegations working", async () => {
    const halted = 8204;
    const healthy = 8205;
    h.execute.mockResolvedValue('{"success":true,"result":"done"}');
    markCreditExhausted(halted, REFUSAL);

    expect(JSON.parse(await harness(halted).callTask(1)).success).toBe(false);
    expect(JSON.parse(await harness(healthy).callTask(1)).success).toBe(true);
  });
});
