/**
 * Automation runner: arms node-cron tasks for schedule triggers and interval
 * pollers for the surviving trigger kinds (schedule, mcp), with a single
 * global FIFO run queue
 * (concurrency 1, per-automation dedupe). Poll loops are deterministic — only
 * a fired trigger costs an agent run.
 *
 * Lifecycle: `startAutomationRunner()` at app boot (next to
 * scheduleCleanupJobs) recovers runs interrupted by a quit, then arms every
 * enabled automation. Definitions are re-armed via `refreshAutomationSchedule`
 * after any CRUD. Cron fires do NOT catch up missed windows (Codex behavior —
 * automations run while Atlarix is open); pollers poll once at boot.
 *
 * MORE THAN ONE PROCESS. The desktop app and the `atlarix` CLI share one
 * database and both run this runner, so each occurrence is CLAIMED first
 * (`claimSlot`, the automation_leases table): a cron occurrence by its minute,
 * an MCP poll by its interval bucket. Whoever inserts the lease runs it; the
 * other skips. Runs carry their process as `owner` and a heartbeat, so a
 * process starting up recovers only runs whose owner is gone — not the other
 * process's live one. And because an automation can be created or edited in
 * the other process, `syncDefinitions` re-arms whatever changed there.
 */

import log from "electron-log";
import {
  schedule,
  validate as validateCron,
  type ScheduledTask,
} from "node-cron";
import { and, eq, gte, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import {
  automationLeases,
  automationRuns,
  automations,
  chatSessions,
} from "@/db/schema";
import {
  AutomationTriggerSchema,
  MIN_POLL_INTERVAL_MINUTES,
  type AutomationTrigger,
  type McpCursor,
} from "./types";
import type { ExecuteRunDeps } from "./execute-run";
import { PROCESS_OWNER } from "./process-owner";

const logger = log.scope("automations");


/** How often a live process refreshes its running runs' heartbeat. */
const HEARTBEAT_MS = 30_000;
/** A running run whose heartbeat is older than this lost its process. */
export const STALE_HEARTBEAT_MS = 2 * 60_000;
/** How often definitions changed by ANOTHER process are picked up. */
const SYNC_MS = 60_000;
const LEASE_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Take one occurrence of an automation for this process. True: run it. False:
 * another process (the desktop app, or the CLI) already took it.
 */
export async function claimSlot(
  automationId: string,
  slotKey: string,
): Promise<boolean> {
  const rows = await db
    .insert(automationLeases)
    .values({ automationId, slotKey, owner: PROCESS_OWNER })
    .onConflictDoNothing()
    .returning({ slotKey: automationLeases.slotKey });
  return rows.length === 1;
}

/** The cron occurrence a fire belongs to: its minute (both processes' clocks are this machine's). */
export function scheduleSlot(at: Date = new Date()): string {
  return `schedule:${at.toISOString().slice(0, 16)}`;
}

/** The poll bucket: one poll per interval across every process. */
export function pollSlot(intervalMinutes: number, at = Date.now()): string {
  return `poll:${Math.floor(at / (intervalMinutes * 60_000))}`;
}

/** Is another process running this automation right now (a live heartbeat)? */
async function runningElsewhere(automationId: string): Promise<boolean> {
  const fresh = new Date(Date.now() - STALE_HEARTBEAT_MS);
  const row = await db.query.automationRuns.findFirst({
    where: and(
      eq(automationRuns.automationId, automationId),
      eq(automationRuns.status, "running"),
      gte(automationRuns.heartbeatAt, fresh),
    ),
  });
  return Boolean(row && row.owner !== PROCESS_OWNER);
}

export interface RunnerDeps {
  executeRun: (
    automationId: string,
    triggerContext: string | null,
    deps?: ExecuteRunDeps,
  ) => Promise<unknown>;
  pollMcp: typeof import("./pollers/mcp").pollMcp;
}

async function defaultDeps(): Promise<RunnerDeps> {
  const [{ executeAutomationRun }, { pollMcp }] = await Promise.all([
    import("./execute-run"),
    import("./pollers/mcp"),
  ]);
  return { executeRun: executeAutomationRun, pollMcp };
}

let runnerDeps: RunnerDeps | null = null;
const cronTasks = new Map<string, ScheduledTask>();
const pollTimers = new Map<string, ReturnType<typeof setInterval>>();

/** Single global FIFO — one unattended run at a time, deduped per automation. */
const queue: Array<{
  automationId: string;
  context: string | null;
  reason: string;
}> = [];
const queuedOrRunning = new Set<string>();
let draining = false;

export function enqueueRun(
  automationId: string,
  triggerContext: string | null,
  reason: "schedule" | "poll" | "manual",
): void {
  if (queuedOrRunning.has(automationId)) {
    logger.info(
      `automation ${automationId} already queued/running — skipping ${reason} fire`,
    );
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
        if (item.reason !== "manual" && (await runningElsewhere(item.automationId))) {
          logger.info(
            `automation ${item.automationId} is running in another Atlarix — skipping ${item.reason} fire`,
          );
          continue;
        }
        const deps = runnerDeps ?? (runnerDeps = await defaultDeps());
        await deps.executeRun(item.automationId, item.context);
      } catch (e) {
        logger.error(
          `automation ${item.automationId} run failed to execute:`,
          e,
        );
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

/**
 * A stored trigger this build can no longer parse must be LOUD, not quiet.
 *
 * Retiring the `pipeline` kind made every saved pipeline automation unparseable.
 * The old behaviour for an unparseable trigger was `return` — so such an
 * automation would sit enabled and simply never fire again, and "never fired" is
 * indistinguishable from "nothing has happened yet", forever. That is precisely
 * the failure the pipeline host registry was built to prevent, so it would have
 * been perverse to reintroduce it while deleting that registry.
 *
 * So: disable it once, and record the reason in the run feed where the user is
 * already looking. `recordPollError` dedupes on the same message, so this says
 * it once rather than every interval.
 */
async function retireUnparseableAutomation(
  automationId: string,
  name: string,
): Promise<void> {
  const row = await db.query.automations.findFirst({
    where: eq(automations.id, automationId),
  });
  if (!row?.enabled) return; // already retired, or off — say nothing more.
  await db
    .update(automations)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(automations.id, automationId));
  disarm(automationId);
  const message =
    "This automation used a trigger type Atlarix no longer supports " +
    "(it polled a single code host). It has been disabled. Recreate it as a " +
    "Schedule or MCP trigger — an MCP server can poll any API, including " +
    "GitHub, GitLab and Bitbucket.";
  logger.warn(`automation "${name}" retired: unsupported trigger type`);
  await recordPollError(automationId, message);
}

// `unknown`: a pipeline host owns its own cursor shape, and the runner only
// stores it. Narrowing here would mean this file knowing every host's internals.
async function persistCursor(
  automationId: string,
  cursor: unknown,
): Promise<void> {
  await db
    .update(automations)
    .set({ cursor: JSON.stringify(cursor), updatedAt: new Date() })
    .where(eq(automations.id, automationId));
}

/** Record a poller failure as an error run so the feed shows what to fix (once per streak). */
async function recordPollError(
  automationId: string,
  message: string,
): Promise<void> {
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
      where: and(
        eq(automationRuns.automationId, automationId),
        eq(automationRuns.error, message),
      ),
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
  if (!trigger) {
    await retireUnparseableAutomation(automationId, automation.name);
    return;
  }
  if (trigger.kind === "schedule") return;
  const deps = runnerDeps ?? (runnerDeps = await defaultDeps());

  try {
    // MCP is the only polled kind now — `schedule` returned above, and the
    // `pipeline` branch went with the trigger kind (see types.ts).
    const cursor = automation.cursor
      ? (JSON.parse(automation.cursor) as McpCursor)
      : null;
    if (automation.workspaceId == null) return;
    const result = await deps.pollMcp(trigger, cursor, automation.workspaceId);
    await persistCursor(automationId, result.nextCursor);
    if (result.fired) enqueueRun(automationId, result.context ?? null, "poll");
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

/** What arming depends on, per automation: a change here (from any process) means re-arm. */
const armedSignature = new Map<string, string>();
const signatureOf = (a: { enabled: boolean; trigger: string }) =>
  `${a.enabled}|${a.trigger}`;

async function arm(automationId: string): Promise<void> {
  disarm(automationId);
  const automation = await db.query.automations.findFirst({
    where: eq(automations.id, automationId),
  });
  if (automation) armedSignature.set(automationId, signatureOf(automation));
  else armedSignature.delete(automationId);
  if (!automation?.enabled) return;
  const trigger = parseTrigger(automation.trigger);
  if (!trigger) {
    // Not just "not armed": disable it and say why, or it stays enabled in the
    // UI while being incapable of firing.
    await retireUnparseableAutomation(automationId, automation.name);
    return;
  }

  if (trigger.kind === "schedule") {
    if (!validateCron(trigger.cron)) {
      logger.warn(
        `automation "${automation.name}" has invalid cron "${trigger.cron}" — not armed`,
      );
      return;
    }
    const task = schedule(trigger.cron, () => {
      void claimSlot(automationId, scheduleSlot()).then(
        (mine) => {
          if (mine) enqueueRun(automationId, null, "schedule");
        },
        (e) => logger.warn(`automation ${automationId}: could not claim its run:`, e),
      );
    });
    cronTasks.set(automationId, task);
  } else {
    const minutes = Math.max(
      trigger.intervalMinutes,
      MIN_POLL_INTERVAL_MINUTES,
    );
    // One poll per interval bucket across processes: two pollers reading the
    // same old cursor would both see the change and both fire.
    const claimedPoll = () =>
      void claimSlot(automationId, pollSlot(minutes)).then(
        (mine) => (mine ? pollOnce(automationId) : undefined),
        (e) => logger.warn(`automation ${automationId}: could not claim its poll:`, e),
      );
    const timer = setInterval(claimedPoll, minutes * 60 * 1000);
    timer.unref?.();
    pollTimers.set(automationId, timer);
    // Boot/creation poll — seeds the cursor (never fires on backlog).
    claimedPoll();
  }
  logger.info(`armed automation "${automation.name}" (${trigger.kind})`);
}

/** Re-arm after create/update/toggle; disarms on delete/disable. */
export async function refreshAutomationSchedule(
  automationId: string,
): Promise<void> {
  await arm(automationId);
}

export function disarmAutomation(automationId: string): void {
  disarm(automationId);
}

/**
 * Pick up what another process changed: an automation created, edited, turned
 * on or off, or deleted in the desktop app while the CLI is open (or the
 * reverse). Compares what arming depends on, NOT updatedAt — a poll's cursor
 * write bumps updatedAt, and re-arming on it would re-poll at once, forever.
 */
async function syncDefinitions(): Promise<void> {
  const rows = await db
    .select({
      id: automations.id,
      enabled: automations.enabled,
      trigger: automations.trigger,
    })
    .from(automations);
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.id);
    const known = armedSignature.get(row.id);
    if (known === signatureOf(row)) continue;
    if (known === undefined && !row.enabled) {
      armedSignature.set(row.id, signatureOf(row));
      continue;
    }
    await arm(row.id);
  }
  for (const id of Array.from(armedSignature.keys())) {
    if (!seen.has(id)) {
      disarm(id);
      armedSignature.delete(id);
    }
  }
}

async function beat(): Promise<void> {
  await db
    .update(automationRuns)
    .set({ heartbeatAt: new Date() })
    .where(
      and(
        eq(automationRuns.owner, PROCESS_OWNER),
        eq(automationRuns.status, "running"),
      ),
    );
}

async function pruneLeases(): Promise<void> {
  await db
    .delete(automationLeases)
    .where(lt(automationLeases.claimedAt, new Date(Date.now() - LEASE_TTL_MS)));
}

/**
 * Startup recovery: a run still "running" whose process is gone was interrupted
 * by a quit. Gone means no owner recorded (a run from before 0077) or a
 * heartbeat older than STALE_HEARTBEAT_MS — never another process's live run.
 */
export async function recoverInterruptedRuns(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_HEARTBEAT_MS);
  const stale = await db
    .select()
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.status, "running"),
        or(
          isNull(automationRuns.owner),
          isNull(automationRuns.heartbeatAt),
          lt(automationRuns.heartbeatAt, cutoff),
        ),
      ),
    );
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
    logger.info(
      `recovered ${stale.length} automation run(s) interrupted by app quit`,
    );
  }
}

const lifecycleTimers: Array<ReturnType<typeof setInterval>> = [];

export function startAutomationRunner(deps?: RunnerDeps): void {
  if (deps) runnerDeps = deps;
  if (lifecycleTimers.length === 0) {
    const every = (ms: number, fn: () => Promise<void>, what: string) => {
      const t = setInterval(() => {
        void fn().catch((e) => logger.warn(`automation ${what} failed:`, e));
      }, ms);
      t.unref?.();
      lifecycleTimers.push(t);
    };
    every(HEARTBEAT_MS, beat, "heartbeat");
    every(SYNC_MS, syncDefinitions, "sync");
    every(60 * 60_000, pruneLeases, "lease prune");
  }
  void (async () => {
    try {
      await recoverInterruptedRuns();
      await pruneLeases().catch(() => {});
      const all = await db
        .select()
        .from(automations)
        .where(eq(automations.enabled, true));
      for (const a of all) {
        await arm(a.id);
      }
      logger.info(
        `automation runner started (${all.length} enabled automation(s))`,
      );
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
  for (const t of lifecycleTimers.splice(0)) clearInterval(t);
  armedSignature.clear();
}

/** Test-only: run one definition sync / heartbeat now instead of on the timer. */
export const syncDefinitionsForTests = syncDefinitions;
export const beatForTests = beat;
