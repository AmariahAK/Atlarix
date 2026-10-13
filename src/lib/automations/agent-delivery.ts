/**
 * A finished automation run, delivered to ONE chat's agent, from whichever
 * process ran it: the app, the CLI, or an editor's agent (`atlarix acp`).
 *
 * Why this exists. A notify-the-agent run's result used to land only in the
 * memory of the process that ran it (automation-results.ts), and only reach
 * the agent with the user's next message there. The owner wants it to wake
 * the chat and let the agent act, as a finished background command or
 * sub-agent does, in the app, the CLI, ACP and the IDE extension alike.
 *
 * How. Every process with live chats asks, for the folders it has open, for
 * finished notify-the-agent runs nobody has taken (`claimFinishedRuns`). Each
 * run is CLAIMED once, across processes, by a row in a small table created on
 * demand (the peers registry's pattern: no migration). The claimer queues the
 * result for its folder (`recordAutomationResult`) and wakes one chat there;
 * that wake turn drains it (collect_results, or the results context section).
 *
 * A result older than WAKE_WINDOW_MS when claimed (no chat was open on that
 * folder when it finished) does not wake anyone: it goes into the next message
 * there, as before. A run the agent itself asked for (operation:"run") is
 * marked delivered at once: its result already went back to that tool call.
 */
import log from "electron-log";
import { getDb } from "@/db";

const logger = log.scope("automation-delivery");
const TABLE = "automation_agent_deliveries";
/** Fresh enough to wake a chat for. */
export const WAKE_WINDOW_MS = 10 * 60_000;
/** How far back an unclaimed run is still worth delivering at all. */
const LOOKBACK_S = 24 * 3600;

type Raw = {
  exec(sql: string): unknown;
  prepare(sql: string): { run(...args: unknown[]): { changes: number | bigint }; all(...args: unknown[]): unknown[] };
};

let rawDb: () => Raw | null = () => {
  try {
    return getDb().$client as unknown as Raw;
  } catch {
    return null;
  }
};

/** Tests point this at their own database. */
export function __setDeliveryDatabaseForTests(fn: () => Raw | null): void {
  rawDb = fn;
}

function ensureTable(d: Raw): void {
  d.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    run_id TEXT PRIMARY KEY NOT NULL,
    claimer TEXT NOT NULL,
    claimed_at INTEGER NOT NULL
  )`);
}

/** Mark a run delivered without queueing it (an agent-requested run: its result went back to the tool). */
export function markRunDelivered(runId: string, claimer: string): void {
  const d = rawDb();
  if (!d) return;
  try {
    ensureTable(d);
    d.prepare(`INSERT OR IGNORE INTO ${TABLE} (run_id, claimer, claimed_at) VALUES (?, ?, ?)`).run(runId, claimer, Date.now());
  } catch (e) {
    logger.warn("could not mark an automation run delivered:", e);
  }
}

type RunRow = {
  run_id: string;
  status: string;
  summary: string | null;
  error: string | null;
  finished_at: number;
  automation_id: string;
  name: string;
  workspace_id: number;
};

/**
 * Take the finished notify-the-agent runs in these folders that no process has
 * taken yet, and queue each for the agent there. Returns the folders that got
 * one, and whether any of those is fresh enough to wake a chat for.
 */
export async function claimFinishedRuns(
  workspaceIds: number[],
  claimer: string,
  now = Date.now(),
): Promise<Array<{ workspaceId: number; wake: boolean }>> {
  const ids = [...new Set(workspaceIds.filter((x) => Number.isInteger(x)))];
  const d = rawDb();
  if (!d || !ids.length) return [];
  let rows: RunRow[] = [];
  try {
    ensureTable(d);
    rows = d
      .prepare(
        `SELECT r.id AS run_id, r.status, r.summary, r.error, r.finished_at, a.id AS automation_id, a.name, a.workspace_id
           FROM automation_runs r JOIN automations a ON a.id = r.automation_id
          WHERE a.notify_agent = 1
            AND a.workspace_id IN (${ids.map(() => "?").join(",")})
            AND r.status IN ('ok', 'error')
            AND r.finished_at IS NOT NULL AND r.finished_at >= ?
            AND r.id NOT IN (SELECT run_id FROM ${TABLE})
          ORDER BY r.finished_at`,
      )
      .all(...ids, Math.floor(now / 1000) - LOOKBACK_S) as RunRow[];
  } catch (e) {
    logger.warn("could not look for finished automation runs:", e);
    return [];
  }
  if (!rows.length) return [];
  const { recordAutomationResult } = await import("@/lib/agent/automation-results");
  const got = new Map<number, boolean>();
  for (const r of rows) {
    let won = false;
    try {
      const res = d.prepare(`INSERT OR IGNORE INTO ${TABLE} (run_id, claimer, claimed_at) VALUES (?, ?, ?)`).run(r.run_id, claimer, now);
      won = Number(res.changes) === 1;
    } catch {
      won = false;
    }
    if (!won) continue; // another process (or chat) took it
    recordAutomationResult(r.workspace_id, {
      automationId: r.automation_id,
      automationName: r.name,
      status: r.status === "error" ? "error" : "ok",
      body: (r.status === "error" ? r.error : r.summary) ?? "",
      finishedAt: r.finished_at * 1000,
    });
    const fresh = now - r.finished_at * 1000 <= WAKE_WINDOW_MS;
    got.set(r.workspace_id, (got.get(r.workspace_id) ?? false) || fresh);
  }
  return [...got].map(([workspaceId, wake]) => ({ workspaceId, wake }));
}
