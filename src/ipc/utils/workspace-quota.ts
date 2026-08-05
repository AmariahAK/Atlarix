/**
 * The Free workspace cap, enforced where a workspace is CREATED.
 *
 * WHY THIS EXISTS RATHER THAN A CLEANUP PASS
 * ------------------------------------------
 * Until v14.27.0 the cap was applied retroactively: `auth:enforce-workspace-limit`
 * ran on sign-in and, for a Free user, DELETED every workspace but the oldest —
 * cascading through chat sessions, MCP servers, daily logs, workflow templates
 * and automations as it went. A plan limit was being enforced by destroying work
 * the user never agreed to lose, and it kept the OLDEST one, which is rarely the
 * one you wanted.
 *
 * Atlarix already had a settled answer to "how do we enforce a Free cap" in two
 * other places, and it is not deletion:
 *
 *   mcp_handlers.ts       "Free tier is limited to 1 MCP server per workspace…"
 *   automations/service   "Free tier is limited to 2 automations per workspace…"
 *
 * Both refuse the CREATE and name the upgrade. This brings workspaces in line.
 *
 * Consequence, deliberate: someone already over the cap (a Pro user who
 * downgraded) keeps everything they have and simply cannot add more. The old
 * code would have deleted the excess at their next sign-in.
 *
 * NOTE this is the MAIN-side guard. `lib/open-workspace.ts` checks the same
 * limit in the renderer before offering to open a folder — that is a UX
 * affordance and does not cover the CLI open path, the duplicate path, or
 * anything that reaches the insert another way.
 */

import { SubscriptionManager } from "@/lib/SubscriptionManager";
import { PlanLimitError } from "@/lib/plan-limit-error";

/**
 * Throws when creating another workspace would exceed the plan's limit.
 *
 * Call this at the point a NEW row is about to be inserted — after any
 * existing-workspace lookup, so re-opening a folder you already have is never
 * blocked by a cap it does not increase.
 */
export async function assertWorkspaceQuota(): Promise<void> {
  const check = await SubscriptionManager.canCreateWorkspace();
  if (!check.allowed) {
    // PlanLimitError, not a bare Error: `sentry-before-send` drops these so an
    // expected plan gate never lands in the error dashboard as a defect.
    throw new PlanLimitError(
      check.reason ??
        `Workspace limit reached (${check.maxAllowed}). Remove one to add another.`,
    );
  }
}

/**
 * Call after a successful insert.
 *
 * `SubscriptionManager.getWorkspaceCount()` memoises, and the only existing
 * invalidation was on DELETE — so without this the count stays stale after a
 * create and the very next check reads a number that is one too low.
 */
export function noteWorkspaceCreated(): void {
  SubscriptionManager.clearWorkspaceCache();
}
