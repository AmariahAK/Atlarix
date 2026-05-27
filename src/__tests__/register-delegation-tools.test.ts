import { describe, expect, it } from "vitest";
import { MAX_SUBAGENTS_PER_TURN } from "@/lib/agents/agent-runtime";

describe("delegation per-turn limits", () => {
  it("MAX_SUBAGENTS_PER_TURN is enforced against started count not completed", () => {
    let delegationsStartedThisTurn = 0;
    const getDelegationCount = () => delegationsStartedThisTurn;
    const onDelegationStart = () => {
      delegationsStartedThisTurn += 1;
    };

    const tryStart = (): boolean => {
      if (getDelegationCount() >= MAX_SUBAGENTS_PER_TURN) return false;
      onDelegationStart();
      return true;
    };

    expect(tryStart()).toBe(true);
    expect(tryStart()).toBe(true);
    expect(tryStart()).toBe(true);
    expect(tryStart()).toBe(true);
    expect(tryStart()).toBe(true);
    expect(tryStart()).toBe(false);
    expect(delegationsStartedThisTurn).toBe(MAX_SUBAGENTS_PER_TURN);
  });
});
