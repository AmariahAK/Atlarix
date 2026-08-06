/**
 * Automation runner: arms node-cron tasks for schedule triggers and interval
 * pollers for github/mcp triggers, with a single global FIFO run queue
 * (concurrency 1, per-automation dedupe). Poll loops are deterministic — only
 * a fired trigger costs an agent run.
 *
 * Lifecycle: `startAutomationRunner()` at app boot (next to
 * scheduleCleanupJobs) recovers runs interrupted by a quit, then arms every
 * enabled automation. Definitions are re-armed via `refreshAutomationSchedule`
 * after any CRUD. Cron fires do NOT catch up missed windows (Codex behavior —
 * automations run while Atlarix is open); pollers poll once at boot.
 */

import log from "electron-log";
import { schedule, validate as validateCron, type ScheduledTask } from "node-cron";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { automationRuns, automations, chatSessions } from "@/db/schema";
import {
  AutomationTriggerSchema,
  MIN_POLL_INTERVAL_MINUTES,
  type AutomationTrigger,
  type McpCursor,
} from "./types";
import type { ExecuteRunDeps } from "./execute-run";

const logger = log.scope("automations");

export interface RunnerDeps {
  executeRun: (
    automationId: string,
    triggerContext: string | null,
    deps?: ExecuteRunDeps,
  ) => Promise<unknown>;
  pollGithub: typeof import("./pollers/github").pollGithub;
  pollMcp: typeof import("./pollers/mcp").pollMcp;
}

async function defaultDeps(): Promise<RunnerDeps> {
  const [{ executeAutomationRun }, { pollGithub }, { pollMcp }] = await Promise.all([
    import("./execute-run"),
    import("./pollers/github"),
    import("./pollers/mcp"),
  ]);
  return { executeRun: executeAutomationRun, pollGithub, pollMcp };
}

let runnerDeps: RunnerDeps | null = null;
const cronTasks = new Map<string, ScheduledTask>();
const pollTimers = new Map<string, ReturnType<typeof setInterval>>();

/** Single global FIFO — one unattended run at a time, deduped per automation. */
const queue: Array<{ automationId: string; context: string | null; reason: string }> = [];
const queuedOrRunning = new Set<string>();
let draining = false;

export function enqueueRun(
  automationId: string,
  triggerContext: string | null,
  reason: "schedule" | "poll" | "manual",
): void {
  if (queuedOrRunning.has(automationId)) {
    logger.info(`automation ${automationId} already queued/running — skipping ${reason} fire`);
    return;
  }
  queuedOrRunning.add(automationId);
  queue.push({ automationId, context: triggerContext, reason });
  void drainQueue();
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const item = queue.shift()!;
      try {
        const deps = runnerDeps ?? (runnerDeps = await defaultDeps());
        await deps.executeRun(item.automationId, item.context);
      } catch (e) {
        logger.error(`automation ${item.automationId} run failed to execute:`, e);
      } finally {
        queuedOrRunning.delete(item.automationId);
      }
    }
  } finally {
    draining = false;
  }
}

function parseTrigger(raw: string): AutomationTrigger | null {
  try {
    return AutomationTriggerSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

// `unknown`: a pipeline host owns its own cursor shape, and the runner only
// stores it. Narrowing here would mean this file knowing every host's internals.
async function persistCursor(automationId: string, cursor: unknown): Promise<void> {
  await db
    .update(automations)
    .set({ cursor: JSON.stringify(cursor), updatedAt: new Date() })
    .where(eq(automations.id, automationId));
}

/** Record a poller failure as an error run so the feed shows what to fix (once per streak). */
async function recordPollError(automationId: string, message: string): Promise<void> {
  const latest = await db.query.automationRuns.findFirst({
    where: eq(automationRuns.automationId, automationId),
    orderBy: (runs, { desc }) => [desc(runs.startedAt)],
  });
  // Don't spam the feed: skip if the latest run is already the same poll error.
  if (latest?.status === "error" && latest.error === message) return;
  const { randomUUID } = await import("node:crypto");
  const now = new Date();
  await db.insert(automationRuns).values({
    id: randomUUID(),
    automationId,
    sessionId: null,
    status: "error",
    error: message,
    startedAt: now,
    finishedAt: now,
  });
  try {
    const { broadcastAutomationRunUpdate } = await import("./notify");
    const row = await db.query.automationRuns.findFirst({
      where: and(eq(automationRuns.automationId, automationId), eq(automationRuns.error, message)),
      orderBy: (runs, { desc }) => [desc(runs.startedAt)],
    });
    if (row) await broadcastAutomationRunUpdate(row.id);
  } catch {
    /* broadcast best-effort */
  }
}

async function pollOnce(automationId: string): Promise<void> {
  const automation = await db.query.automations.findFirst({
    where: eq(automations.id, automationId),
  });
  if (!automation?.enabled) return;
  const trigger = parseTrigger(automation.trigger);
  if (!trigger || trigger.kind === "schedule") return;
  const deps = runnerDeps ?? (runnerDeps = await defaultDeps());

  try {
    if (trigger.kind === "pipeline") {
      // Dispatch by HOST through the registry rather than by a hardcoded vendor
      // branch — adding GitLab is a registry entry, not an edit here.
      const { getPipelineHost } = await import("./pipeline-hosts");
      const host = getPipelineHost(trigger.host);
      if (!host) {
        // Registered at create time, so this means a build without that poller.
        // Say it once rather than failing silently every interval.
        throw new Error(
          `No poller registered for pipeline host "${trigger.host}" — this automation cannot fire.`,
        );
      }
      const cursor = automation.cursor ? (JSON.parse(automation.cursor) as unknown) : null;
      const result = await host.poll(trigger, cursor);
      await persistCursor(automationId, result.nextCursor);
      if (result.fired) enqueueRun(automationId, result.context ?? null, "poll");
    } else {
      const cursor = automation.cursor ? (JSON.parse(automation.cursor) as McpCursor) : null;
      if (automation.workspaceId == null) return;
      const result = await deps.pollMcp(trigger, cursor, automation.workspaceId);
      await persistCursor(automationId, result.nextCursor);
      if (result.fired) enqueueRun(automationId, result.context ?? null, "poll");
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(`automation "${automation.name}" poll failed: ${message}`);
    await recordPollError(automationId, message).catch(() => {});
  }
}

function disarm(automationId: string): void {
  cronTasks.get(automationId)?.stop();
  cronTasks.delete(automationId);
  const timer = pollTimers.get(automationId);
  if (timer) clearInterval(timer);
  pollTimers.delete(automationId);
}

async function arm(automationId: string): Promise<void> {
  disarm(automationId);
  const automation = await db.query.automations.findFirst({
    where: eq(automations.id, automationId),
  });
  if (!automation?.enabled) return;
  const trigger = parseTrigger(automation.trigger);
  if (!trigger) {
    logger.warn(`automation "${automation.name}" has an invalid trigger — not armed`);
    return;
  }

  if (trigger.kind === "schedule") {
    if (!validateCron(trigger.cron)) {
      logger.warn(`automation "${automation.name}" has invalid cron "${trigger.cron}" — not armed`);
      return;
    }
    const task = schedule(trigger.cron, () => {
      enqueueRun(automationId, null, "schedule");
    });
    cronTasks.set(automationId, task);
  } else {
    const minutes = Math.max(trigger.intervalMinutes, MIN_POLL_INTERVAL_MINUTES);
    const timer = setInterval(() => {
      void pollOnce(automationId);
    }, minutes * 60 * 1000);
    timer.unref?.();
    pollTimers.set(automationId, timer);
    // Boot/creation poll — seeds the cursor (never fires on backlog).
    void pollOnce(automationId);
  }
  logger.info(`armed automation "${automation.name}" (${trigger.kind})`);
}

/** Re-arm after create/update/toggle; disarms on delete/disable. */
export async function refreshAutomationSchedule(automationId: string): Promise<void> {
  await arm(automationId);
}

export function disarmAutomation(automationId: string): void {
  disarm(automationId);
}

/** Boot recovery: anything still "running" was interrupted by a quit. */
async function recoverInterruptedRuns(): Promise<void> {
  const stale = await db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.status, "running"));
  for (const run of stale) {
    await db
      .update(automationRuns)
      .set({
        status: "error",
        error: "interrupted by app quit",
        finishedAt: new Date(),
      })
      .where(eq(automationRuns.id, run.id));
    if (run.sessionId) {
      await db
        .update(chatSessions)
        .set({ status: "error", statusError: "interrupted by app quit" })
        .where(eq(chatSessions.id, run.sessionId));
    }
  }
  if (stale.length > 0) {
    logger.info(`recovered ${stale.length} automation run(s) interrupted by app quit`);
  }
}

export function startAutomationRunner(deps?: RunnerDeps): void {
  if (deps) runnerDeps = deps;
  void (async () => {
    try {
      await recoverInterruptedRuns();
      const all = await db.select().from(automations).where(eq(automations.enabled, true));
      for (const a of all) {
        await arm(a.id);
      }
      logger.info(`automation runner started (${all.length} enabled automation(s))`);
    } catch (e) {
      logger.error("automation runner failed to start:", e);
    }
  })();
}

/** Test-only: clear all timers/queues between cases. */
export function resetAutomationRunnerForTests(): void {
  for (const id of Array.from(cronTasks.keys())) disarm(id);
  for (const id of Array.from(pollTimers.keys())) disarm(id);
  queue.length = 0;
  queuedOrRunning.clear();
  draining = false;
  runnerDeps = null;
}
