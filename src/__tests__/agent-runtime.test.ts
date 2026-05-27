import { describe, expect, it } from "vitest";
import {
  getDelegationConfig,
  shouldAutoApprovePermissions,
  delegationChatModeFromWorkMode,
  isDelegationAllowedForWorkMode,
  MAX_SUBAGENTS_PER_TURN,
} from "@/lib/agents/agent-runtime";

describe("agent-runtime", () => {
  it("shouldAutoApprovePermissions is always false", () => {
    expect(shouldAutoApprovePermissions("autonomous", 1)).toBe(false);
    expect(shouldAutoApprovePermissions(undefined, undefined)).toBe(false);
  });

  it("getDelegationConfig merges legacy autonomous settings", () => {
    const cfg = getDelegationConfig({
      aiConfiguration: {
        autonomous: { maxDelegationDepth: 4, maxDelegationsPerTurn: 5 },
      },
    } as never);
    expect(cfg.maxDelegationDepth).toBe(4);
    expect(cfg.maxDelegationsPerTurn).toBe(5);
  });

  it("delegationChatModeFromWorkMode maps work modes", () => {
    expect(delegationChatModeFromWorkMode("ask")).toBe("ask");
    expect(delegationChatModeFromWorkMode("plan")).toBe("plan");
    expect(delegationChatModeFromWorkMode("build")).toBe("build");
    expect(delegationChatModeFromWorkMode("debug")).toBe("build");
  });

  it("isDelegationAllowedForWorkMode is explore and review only", () => {
    expect(isDelegationAllowedForWorkMode("ask")).toBe(true);
    expect(isDelegationAllowedForWorkMode("review")).toBe(true);
    expect(isDelegationAllowedForWorkMode("build")).toBe(false);
    expect(isDelegationAllowedForWorkMode("plan")).toBe(false);
  });

  it("defaults max delegations to 5", () => {
    expect(getDelegationConfig({} as never).maxDelegationsPerTurn).toBe(
      MAX_SUBAGENTS_PER_TURN,
    );
  });

  it("defaults max concurrent delegations to 5", () => {
    expect(getDelegationConfig({} as never).maxConcurrentDelegations).toBe(
      MAX_SUBAGENTS_PER_TURN,
    );
  });
});
