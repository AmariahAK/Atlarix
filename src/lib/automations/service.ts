/**
 * Automation CRUD, shared by the IPC handlers (the user's Automations tab) and
 * the `automations` tool (the agent).
 *
 * WHY A SERVICE RATHER THAN THE TOOL CALLING IPC
 * ----------------------------------------------
 * Creating an automation is not just an INSERT: it enforces the per-workspace
 * tier caps, upserts `consent: "always"` for an MCP trigger's tool (the poller
 * runs unattended and must never prompt), and re-arms the scheduler. A tool that
 * reimplemented any of that would drift from the UI the first time one of them
 * changed — and the failure would be silent, because a missing MCP consent looks
 * like "the poll returned nothing".
 *
 * So both callers land here. The only asymmetry is deliberate: the tool's
 * mutations reach this module only AFTER the approval gate has run, exactly as a
 * file write does.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import log from "electron-log";
import { db } from "@/db";
import { apps, automationRuns, automations, mcpToolConsents } from "@/db/schema";
import { SubscriptionManager } from "@/lib/SubscriptionManager";
import type { AutomationInput } from "./types";
import {
  AUTOMATIONS_FREE_MAX as FREE_MAX,
  AUTOMATIONS_PRO_MAX as PRO_MAX,
} from "@/lib/plan-caps";

const logger = log.scope("automations-service");

/**
 * Automations per workspace. Re-exported from `lib/plan-caps` so enforcement,
 * the reported limit and the sentence the model reads cannot drift apart.
 */
export const AUTOMATIONS_FREE_MAX = FREE_MAX;
export const AUTOMATIONS_WORKSPACE_MAX = PRO_MAX;

export type AutomationRow = typeof automations.$inferSelect;

export function mapAutomation(row: AutomationRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    enabled: row.enabled,
    trigger: JSON.parse(row.trigger) as unknown,
    prompt: row.prompt,
    runMode: row.runMode,
    notifyAgent: row.notifyAgent,
    model: row.model
      ? (JSON.parse(row.model) as { provider: string; name: string })
      : null,
    lastRunAt: row.lastRunAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
  };
}

export type MappedAutomation = ReturnType<typeof mapAutomation>;

/**
 * An MCP-triggered automation polls a tool with nobody watching, so its consent
 * is recorded at save time. The form says so outright; the tool description does
 * too, because "this will grant standing consent to that MCP tool" is exactly
 * the sort of consequence the model should be stating out loud rather than
 * discovering.
 */
async function upsertMcpConsentIfNeeded(input: AutomationInput): Promise<void> {
  if (input.trigger.kind !== "mcp") return;
  const { serverId, tool } = input.trigger;
  await db
    .insert(mcpToolConsents)
    .values({ serverId, toolName: tool, consent: "always", updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [mcpToolConsents.serverId, mcpToolConsents.toolName],
      set: { consent: "always", updatedAt: new Date() },
    });
}

async function refreshSchedule(automationId: string): Promise<void> {
  const { refreshAutomationSchedule } = await import("./runner");
  await refreshAutomationSchedule(automationId);
}

export async function listAutomations(workspaceId: number): Promise<{
  automations: MappedAutomation[];
  unreadCount: number;
}> {
  const rows = await db
    .select()
    .from(automations)
    .where(eq(automations.workspaceId, workspaceId))
    .orderBy(desc(automations.createdAt));
  const unreadRow = await db
    .select({ count: sql<number>`count(*)` })
    .from(automationRuns)
    .innerJoin(automations, eq(automationRuns.automationId, automations.id))
    .where(
      and(
        eq(automations.workspaceId, workspaceId),
        eq(automationRuns.unread, true),
        eq(automationRuns.archived, false),
      ),
    );
  return {
    automations: rows.map(mapAutomation),
    unreadCount: unreadRow[0]?.count ?? 0,
  };
}

export async function getAutomation(id: string): Promise<MappedAutomation | null> {
  const row = await db.query.automations.findFirst({
    where: eq(automations.id, id),
  });
  return row ? mapAutomation(row) : null;
}

export async function createAutomation(
  workspaceId: number,
  input: AutomationInput,
): Promise<{ id: string }> {
  const app = await db.query.apps.findFirst({ where: eq(apps.id, workspaceId) });
  if (!app) throw new Error("Workspace not found");

  const existing = await db
    .select({ count: sql<number>`count(*)` })
    .from(automations)
    .where(eq(automations.workspaceId, workspaceId));
  const count = existing[0]?.count ?? 0;
  if (count >= AUTOMATIONS_WORKSPACE_MAX) {
    throw new Error(
      `Maximum ${AUTOMATIONS_WORKSPACE_MAX} automations per workspace. Remove one to add another.`,
    );
  }
  if (!SubscriptionManager.isPro() && count >= AUTOMATIONS_FREE_MAX) {
    throw new Error(
      `Free tier is limited to ${AUTOMATIONS_FREE_MAX} automations per workspace. Upgrade to Pro for up to ${AUTOMATIONS_WORKSPACE_MAX}.`,
    );
  }

  await upsertMcpConsentIfNeeded(input);
  const id = randomUUID();
  const now = new Date();
  await db.insert(automations).values({
    id,
    workspaceId,
    name: input.name,
    enabled: input.enabled,
    trigger: JSON.stringify(input.trigger),
    prompt: input.prompt,
    runMode: input.runMode,
    notifyAgent: input.notifyAgent,
    model: input.model ? JSON.stringify(input.model) : null,
    createdAt: now,
    updatedAt: now,
  });
  await refreshSchedule(id);
  logger.log(
    `created automation "${input.name}" (${input.trigger.kind}, runMode=${input.runMode}, notifyAgent=${input.notifyAgent})`,
  );
  return { id };
}

export async function updateAutomation(
  id: string,
  input: AutomationInput,
): Promise<void> {
  await upsertMcpConsentIfNeeded(input);
  await db
    .update(automations)
    .set({
      name: input.name,
      enabled: input.enabled,
      trigger: JSON.stringify(input.trigger),
      prompt: input.prompt,
      runMode: input.runMode,
      notifyAgent: input.notifyAgent,
      model: input.model ? JSON.stringify(input.model) : null,
      // Trigger change invalidates the poll cursor (repo/tool may differ).
      cursor: null,
      updatedAt: new Date(),
    })
    .where(eq(automations.id, id));
  await refreshSchedule(id);
}

export async function deleteAutomation(id: string): Promise<void> {
  const { disarmAutomation } = await import("./runner");
  disarmAutomation(id);
  await db.delete(automations).where(eq(automations.id, id));
}

export async function setAutomationEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  await db
    .update(automations)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(automations.id, id));
  await refreshSchedule(id);
}

/**
 * Flip only `notifyAgent`, without requiring a full re-validated input.
 *
 * Its own entry point because it is meant to be cheap: the owner's whole point
 * in making the field required was that choosing is easy to revise, so "stop
 * telling the AI about this one" should not mean reconstructing and
 * re-validating the trigger. It also deliberately does NOT touch the cursor —
 * this changes who hears about a run, not what is being watched.
 */
export async function setAutomationNotifyAgent(
  id: string,
  notifyAgent: boolean,
): Promise<void> {
  await db
    .update(automations)
    .set({ notifyAgent, updatedAt: new Date() })
    .where(eq(automations.id, id));
}
