/**
 * The agent can tell a plan limit from a broken workspace.
 *
 * It used to learn a cap only by hitting it, and it has no other way to know
 * which tier the user is on — nothing in the system prompt, the mode bundles or
 * AGENTS.md mentions a plan. So "you can't add another MCP server" arrived with
 * no context and read as a fault to be debugged.
 *
 * EVERY ASSERTION COMPARES AGAINST THE IMPORTED CONSTANT, never a literal. A
 * test containing "10" drifts from the code exactly the way the tool description
 * would, which is the whole failure this guards.
 */
import { describe, it, expect } from "vitest";
import {
  MCP_FREE_MAX,
  MCP_PRO_MAX,
  AUTOMATIONS_FREE_MAX,
  AUTOMATIONS_PRO_MAX,
  describePlanCap,
  planCapClause,
  capRemedy,
} from "@/lib/plan-caps";

describe("describePlanCap", () => {
  it("reports the cap that applies to THIS user, plus what Pro would give", () => {
    const free = describePlanCap("automations", false, 0);
    expect(free.tier).toBe("free");
    expect(free.max).toBe(AUTOMATIONS_FREE_MAX);
    expect(free.proMax).toBe(AUTOMATIONS_PRO_MAX);

    const pro = describePlanCap("automations", true, 0);
    expect(pro.tier).toBe("pro");
    expect(pro.max).toBe(AUTOMATIONS_PRO_MAX);
  });

  it("says when there is no room left", () => {
    expect(describePlanCap("mcp", false, MCP_FREE_MAX).canAddMore).toBe(false);
    expect(describePlanCap("mcp", false, MCP_FREE_MAX - 1).canAddMore).toBe(true);
    expect(describePlanCap("mcp", true, MCP_FREE_MAX).canAddMore).toBe(true);
    expect(describePlanCap("mcp", true, MCP_PRO_MAX).canAddMore).toBe(false);
  });

  it("still reports a cap when the user is somehow over it", () => {
    // A downgrade can leave someone above the limit. `canAddMore` must be false
    // without the numbers going strange.
    const over = describePlanCap("automations", false, AUTOMATIONS_PRO_MAX);
    expect(over.canAddMore).toBe(false);
    expect(over.used).toBe(AUTOMATIONS_PRO_MAX);
    expect(over.max).toBe(AUTOMATIONS_FREE_MAX);
  });
});

describe("planCapClause — what the model actually reads", () => {
  it("names both tiers from the constants", () => {
    const mcp = planCapClause("mcp");
    expect(mcp).toContain(String(MCP_FREE_MAX));
    expect(mcp).toContain(String(MCP_PRO_MAX));
    expect(mcp).toContain("MCP servers");

    const auto = planCapClause("automations");
    expect(auto).toContain(String(AUTOMATIONS_FREE_MAX));
    expect(auto).toContain(String(AUTOMATIONS_PRO_MAX));
    expect(auto).toContain("automations");
  });

  it("says a cap is a plan limit, not a broken workspace", () => {
    // The owner's actual ask: the agent should not diagnose a plan limit as a
    // workspace problem. Saying the numbers without saying this leaves the
    // misdiagnosis intact.
    for (const kind of ["mcp", "automations"] as const) {
      expect(planCapClause(kind)).toMatch(/NOT a broken workspace/i);
    }
  });

  it("offers a remedy rather than a retry", () => {
    for (const kind of ["mcp", "automations"] as const) {
      const clause = planCapClause(kind);
      expect(clause).toMatch(/remove one/i);
      expect(clause).toMatch(/instead of retrying/i);
    }
  });

  it("tells the model NOT to suggest upgrading on Pro", () => {
    // Pro IS the top tier. Recommending an upgrade that does not exist is worse
    // than saying nothing — the user goes looking for a purchase page.
    for (const kind of ["mcp", "automations"] as const) {
      expect(planCapClause(kind)).toMatch(/no higher tier/i);
    }
  });
});

describe("capRemedy — tier-aware, because the answer differs", () => {
  it("offers the upgrade on Free", () => {
    expect(capRemedy("automations", false)).toMatch(/upgrade to Pro/i);
    expect(capRemedy("automations", false)).toContain(String(AUTOMATIONS_PRO_MAX));
  });

  it("does NOT recommend an upgrade on Pro, and says why", () => {
    // The assertion is about the RECOMMENDATION, not the word: "nothing to
    // upgrade to" is a denial and must stay allowed. A first draft banned
    // /upgrade to/ outright and failed on the correct string.
    const pro = capRemedy("automations", true);
    expect(pro).not.toMatch(/upgrade to Pro/i);
    expect(pro).toMatch(/top tier|nothing to upgrade/i);
    expect(pro).toContain(String(AUTOMATIONS_PRO_MAX));
  });

  it("says the same for MCP servers, from the MCP constants", () => {
    expect(capRemedy("mcp", false)).toContain(String(MCP_PRO_MAX));
    expect(capRemedy("mcp", true)).not.toMatch(/upgrade to Pro/i);
    expect(capRemedy("mcp", true)).toMatch(/top tier/i);
  });
});

describe("the caps the handlers enforce are the caps the model is told", () => {
  it("automations service re-exports the shared constants", async () => {
    const svc = await import("@/lib/automations/service");
    expect(svc.AUTOMATIONS_FREE_MAX).toBe(AUTOMATIONS_FREE_MAX);
    expect(svc.AUTOMATIONS_WORKSPACE_MAX).toBe(AUTOMATIONS_PRO_MAX);
  });
});
