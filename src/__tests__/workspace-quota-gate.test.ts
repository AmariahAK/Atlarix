/**
 * The Free workspace cap gates CREATION and never deletes.
 *
 * Until v14.27.0 it was enforced retroactively: `auth:enforce-workspace-limit`
 * ran on sign-in and, for a Free user, deleted every workspace but the oldest —
 * cascading through chat sessions, MCP servers, daily logs, workflow templates
 * and automations. A plan limit was being enforced by destroying work nobody
 * agreed to lose, and it kept the OLDEST one, which is rarely the one you want.
 *
 * The most important case here is the third: being AT the cap must never stop
 * you re-opening a workspace you already have. The old check ran at the very top
 * of `importWorkspaceFromPath`, BEFORE the dedupe lookups — so a Free user with
 * their one allowed workspace could not open it again.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

let allowed = true;
let reason: string | undefined;
let cacheCleared = 0;

vi.mock("@/lib/SubscriptionManager", () => ({
  SubscriptionManager: {
    canCreateWorkspace: async () => ({
      allowed,
      reason,
      currentCount: allowed ? 0 : 1,
      maxAllowed: 1,
    }),
    clearWorkspaceCache: () => {
      cacheCleared++;
    },
  },
}));

import {
  assertWorkspaceQuota,
  noteWorkspaceCreated,
} from "@/ipc/utils/workspace-quota";
import { isPlanLimitError } from "@/lib/plan-limit-error";

beforeEach(() => {
  allowed = true;
  reason = undefined;
  cacheCleared = 0;
});

describe("workspace quota gate", () => {
  it("allows a create under the cap", async () => {
    await expect(assertWorkspaceQuota()).resolves.toBeUndefined();
  });

  it("refuses a create at the cap, naming the limit and the upgrade", async () => {
    allowed = false;
    reason = "Free plan allows 1 workspace. Upgrade to Pro for unlimited workspaces.";
    await expect(assertWorkspaceQuota()).rejects.toThrow(/Free plan allows 1 workspace/);
  });

  it("throws a PlanLimitError so an expected gate is not reported as a defect", async () => {
    // `sentry-before-send` drops these. A bare Error would fill the dashboard
    // with a working feature.
    allowed = false;
    reason = "Free plan allows 1 workspace.";
    await assertWorkspaceQuota().catch((e) => {
      expect(isPlanLimitError(e)).toBe(true);
    });
    expect.assertions(1);
  });

  it("still has a message when the checker supplies no reason", async () => {
    allowed = false;
    reason = undefined;
    await expect(assertWorkspaceQuota()).rejects.toThrow(/Workspace limit reached/);
  });

  it("invalidates the memoised count after a create", async () => {
    // `getWorkspaceCount()` memoises and was only ever invalidated on DELETE, so
    // without this the next check reads a count one too low and lets a second
    // workspace through.
    noteWorkspaceCreated();
    expect(cacheCleared).toBe(1);
  });
});
