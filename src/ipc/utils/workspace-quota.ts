/**
 * Workspace count bookkeeping.
 *
 * THERE IS NO LONGER A WORKSPACE CAP. The desktop app went free on 2026-09-08 — every
 * feature is on every plan, and what you pay for is Atlarix Core inference — so
 * `assertWorkspaceQuota` and the Free limit of one workspace are gone.
 *
 * Worth keeping the history, because the cap was got wrong twice before it was got
 * right. Until v14.27.0 it was enforced RETROACTIVELY: `auth:enforce-workspace-limit`
 * ran on sign-in and, for a Free user, DELETED every workspace but the oldest —
 * cascading through chat sessions, MCP servers, daily logs, workflow templates and
 * automations as it went. A plan limit enforced by destroying work the user never
 * agreed to lose, keeping the oldest workspace, which is rarely the one you wanted.
 * It was then replaced by a refusal at CREATE time, which was correct, and is now
 * removed entirely because there is nothing to refuse.
 *
 * What remains is the cache invalidation, which was never about plans.
 */

import { SubscriptionManager } from "@/lib/SubscriptionManager";

/**
 * Call after a successful workspace insert.
 *
 * `SubscriptionManager.getWorkspaceCount()` memoises, and the only other invalidation
 * is on DELETE — so without this the count stays stale after a create and the next read
 * is one too low. Still consumed by `auth:get-plan-info`, which reports the count for
 * display.
 */
export function noteWorkspaceCreated(): void {
  SubscriptionManager.clearWorkspaceCache();
}
