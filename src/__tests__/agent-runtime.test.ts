import { describe, expect, it } from "vitest";
import {
  shouldAutoApprovePermissions,
  MAX_SUBAGENTS_PER_TURN,
} from "@/lib/agents/agent-runtime";

describe("agent-runtime", () => {
  it("shouldAutoApprovePermissions is always false", () => {
    expect(shouldAutoApprovePermissions("autonomous", 1)).toBe(false);
    expect(shouldAutoApprovePermissions(undefined, undefined)).toBe(false);
  });

  it("caps sub-agents at 5 per turn", () => {
    expect(MAX_SUBAGENTS_PER_TURN).toBe(5);
  });
});
