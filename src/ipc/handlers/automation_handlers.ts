/**
 * Automations IPC: definition CRUD, the triage-feed run list, mark-read /
 * archive, run-now, and proposal apply. Trigger payloads are zod-validated
 * here; MCP triggers upsert consent="always" at save time (the form states
 * this explicitly — the poller never prompts).
 */

import { randomUUID } from "node:crypto";
import log from "electron-log";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { apps, automationRuns, automations, mcpToolConsents } from "../../db/schema";
import { createLoggedHandler } from "./safe_handle";
import {
  AutomationInputSchema,
  type AutomationInput,
} from "@/lib/automations/types";
import { getAutomationRunView } from "@/lib/automations/notify";
import { resolveAppPath } from "../../paths/paths";
import { SubscriptionManager } from "../../lib/SubscriptionManager";

const logger = log.scope("automation_handlers");
const handle = createLoggedHandler(logger);

/** Automations per workspace: Free = 2, Pro = 10. */
const AUTOMATIONS_FREE_MAX = 2;
const AUTOMATIONS_WORKSPACE_MAX = 10;

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
  const { refreshAutomationSchedule } = await import("@/lib/automations/runner");
  await refreshAutomationSchedule(automationId);
}

function mapAutomation(row: typeof automations.$inferSelect) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    enabled: row.enabled,
    trigger: JSON.parse(row.trigger) as unknown,
    prompt: row.prompt,
    runMode: row.runMode,
    model: row.model ? (JSON.parse(row.model) as { provider: string; name: string }) : null,
    lastRunAt: row.lastRunAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
  };
}

export function registerAutomationHandlers(): void {
  handle("automations:list", async (_event, workspaceId: number) => {
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
  });

  handle(
    "automations:create",
    async (_event, payload: { workspaceId: number; input: unknown }) => {
      const input = AutomationInputSchema.parse(payload.input);
      const app = await db.query.apps.findFirst({
        where: eq(apps.id, payload.workspaceId),
      });
      if (!app) throw new Error("Workspace not found");

      const existing = await db
        .select({ count: sql<number>`count(*)` })
        .from(automations)
        .where(eq(automations.workspaceId, payload.workspaceId));
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
        workspaceId: payload.workspaceId,
        name: input.name,
        enabled: input.enabled,
        trigger: JSON.stringify(input.trigger),
        prompt: input.prompt,
        runMode: input.runMode,
        model: input.model ? JSON.stringify(input.model) : null,
        createdAt: now,
        updatedAt: now,
      });
      await refreshSchedule(id);
      return { id };
    },
  );

  handle(
    "automations:update",
    async (_event, payload: { id: string; input: unknown }) => {
      const input = AutomationInputSchema.parse(payload.input);
      await upsertMcpConsentIfNeeded(input);
      await db
        .update(automations)
        .set({
          name: input.name,
          enabled: input.enabled,
          trigger: JSON.stringify(input.trigger),
          prompt: input.prompt,
          runMode: input.runMode,
          model: input.model ? JSON.stringify(input.model) : null,
          // Trigger change invalidates the poll cursor (repo/tool may differ).
          cursor: null,
          updatedAt: new Date(),
        })
        .where(eq(automations.id, payload.id));
      await refreshSchedule(payload.id);
      return { ok: true };
    },
  );

  handle("automations:delete", async (_event, id: string) => {
    const { disarmAutomation } = await import("@/lib/automations/runner");
    disarmAutomation(id);
    await db.delete(automations).where(eq(automations.id, id));
    return { ok: true };
  });

  handle(
    "automations:toggle",
    async (_event, payload: { id: string; enabled: boolean }) => {
      await db
        .update(automations)
        .set({ enabled: payload.enabled, updatedAt: new Date() })
        .where(eq(automations.id, payload.id));
      await refreshSchedule(payload.id);
      return { ok: true };
    },
  );

  handle("automations:run-now", async (_event, id: string) => {
    const { enqueueRun } = await import("@/lib/automations/runner");
    enqueueRun(id, null, "manual");
    return { ok: true };
  });

  handle(
    "automations:runs",
    async (
      _event,
      payload: { workspaceId: number; includeArchived?: boolean },
    ) => {
      const rows = await db
        .select({ run: automationRuns })
        .from(automationRuns)
        .innerJoin(automations, eq(automationRuns.automationId, automations.id))
        .where(
          payload.includeArchived
            ? eq(automations.workspaceId, payload.workspaceId)
            : and(
                eq(automations.workspaceId, payload.workspaceId),
                eq(automationRuns.archived, false),
              ),
        )
        .orderBy(desc(automationRuns.startedAt))
        .limit(100);
      const views = await Promise.all(rows.map((r) => getAutomationRunView(r.run.id)));
      return views.filter(Boolean);
    },
  );

  handle("automations:mark-read", async (_event, runIds: string[]) => {
    for (const id of runIds) {
      await db
        .update(automationRuns)
        .set({ unread: false })
        .where(eq(automationRuns.id, id));
    }
    return { ok: true };
  });

  handle("automations:archive", async (_event, runId: string) => {
    await db
      .update(automationRuns)
      .set({ archived: true, unread: false })
      .where(eq(automationRuns.id, runId));
    return { ok: true };
  });

  handle("automations:proposal-diff", async (_event, runId: string) => {
    const run = await db.query.automationRuns.findFirst({
      where: eq(automationRuns.id, runId),
    });
    return run?.proposalDiff ?? null;
  });

  handle("automations:apply-proposal", async (_event, runId: string) => {
    const run = await db.query.automationRuns.findFirst({
      where: eq(automationRuns.id, runId),
    });
    if (!run?.proposalDiff) throw new Error("Run has no proposal to apply");
    if (run.proposalAppliedAt) return { applied: true, alreadyApplied: true };
    const automation = await db.query.automations.findFirst({
      where: eq(automations.id, run.automationId),
    });
    if (!automation?.workspaceId) throw new Error("Automation workspace missing");
    const app = await db.query.apps.findFirst({
      where: eq(apps.id, automation.workspaceId),
    });
    if (!app) throw new Error("Workspace not found");
    const workspacePath = resolveAppPath(app.path);

    // Deterministic apply: git apply --3way against the live workspace.
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const { exec } = await import("../utils/system_git_exec");
    const patchPath = path.join(
      os.tmpdir(),
      `atlarix-automation-${runId.slice(0, 8)}.patch`,
    );
    await fs.writeFile(patchPath, run.proposalDiff, "utf-8");
    try {
      const result = await exec(["apply", "--3way", patchPath], workspacePath);
      if (result.exitCode !== 0) {
        return {
          applied: false,
          conflict: true,
          message: result.stderr.trim() || result.stdout.trim() || "git apply failed",
        };
      }
    } finally {
      await fs.unlink(patchPath).catch(() => {});
    }
    await db
      .update(automationRuns)
      .set({ proposalAppliedAt: new Date(), unread: false })
      .where(eq(automationRuns.id, runId));
    return { applied: true };
  });
}
