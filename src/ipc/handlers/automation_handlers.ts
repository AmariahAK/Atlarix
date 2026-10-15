/**
 * Automations IPC: definition CRUD, the triage-feed run list, mark-read /
 * archive, run-now, and proposal apply. Trigger payloads are zod-validated
 * here; MCP triggers upsert consent="always" at save time (the form states
 * this explicitly — the poller never prompts).
 */

import log from "electron-log";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { automationRuns, automations } from "../../db/schema";
import { createLoggedHandler } from "./safe_handle";
import { AutomationInputSchema } from "@/lib/automations/types";
import {
  listAutomations as listAutomationsService,
  createAutomation as createAutomationService,
  updateAutomation as updateAutomationService,
  deleteAutomation as deleteAutomationService,
  setAutomationEnabled as setAutomationEnabledService,
} from "@/lib/automations/service";
import { getAutomationRunView } from "@/lib/automations/notify";

const logger = log.scope("automation_handlers");
const handle = createLoggedHandler(logger);

export function registerAutomationHandlers(): void {
  handle("automations:list", async (_event, workspaceId: number) => {
    return listAutomationsService(workspaceId);
  });

  handle(
    "automations:create",
    async (_event, payload: { workspaceId: number; input: unknown }) => {
      const input = AutomationInputSchema.parse(payload.input);
      return createAutomationService(payload.workspaceId, input);
    },
  );

  handle(
    "automations:update",
    async (_event, payload: { id: string; input: unknown }) => {
      const input = AutomationInputSchema.parse(payload.input);
      await updateAutomationService(payload.id, input);
      return { ok: true };
    },
  );

  handle("automations:delete", async (_event, id: string) => {
    await deleteAutomationService(id);
    return { ok: true };
  });

  handle(
    "automations:toggle",
    async (_event, payload: { id: string; enabled: boolean }) => {
      await setAutomationEnabledService(payload.id, payload.enabled);
      return { ok: true };
    },
  );

  handle("automations:run-now", async (_event, id: string) => {
    const { enqueueRun } = await import("@/lib/automations/runner");
    // The user's own run: its feed line and the agent say so, not "on schedule".
    enqueueRun(id, "Run now: started by hand, not by its schedule.", "manual");
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
      const views = await Promise.all(
        rows.map((r) => getAutomationRunView(r.run.id)),
      );
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
}
