/**
 * Re-seed the plan ledger when the agent writes the plan file itself.
 *
 * The plan lives in two places: `.atlarix/`'s markdown file (which the model
 * edits like any other file) and the in-memory ledger the UI and the completion
 * gate read. When the model rewrites the markdown directly rather than going
 * through the `plan` tool, the ledger has to follow — otherwise the card, the
 * panel and the gate all describe a plan that no longer exists on disk.
 *
 * Lifted out of `PermissionInterceptor` in v14.26.0. It had been living there
 * because that is where a completed write is observed, but plan bookkeeping is
 * not a permission concern, and it was carrying a static Map of its own inside a
 * class whose other state is all per-workspace instance state. Behaviour is
 * unchanged; only the address is.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import log from "electron-log";
import { isAtlarixPlanRelativePath } from "./plan-sync";

const logger = log.scope("plan-ledger-from-file");

/**
 * Skip a redundant full re-seed when the model writes the same plan body twice
 * in quick succession — which it does, because a plan edit often lands as a
 * `replace` immediately followed by the tool's own sync.
 *
 * Module-level rather than per-interceptor: the guard is about a workspace's
 * plan file, and a new interceptor is constructed per turn, so instance state
 * would reset the debounce exactly when it is needed.
 */
const refreshGuard = new Map<string, { hash: string; at: number }>();

const DEBOUNCE_MS = 450;

/** Test seam — the guard is module state and would otherwise leak across cases. */
export function resetPlanLedgerRefreshGuard(): void {
  refreshGuard.clear();
}

export async function refreshPlanLedgerFromWrittenFile(params: {
  workspaceId: number | null;
  workspacePath: string;
  activeChatId: number;
  fullPath: string;
  rel: string;
}): Promise<void> {
  const { workspaceId, workspacePath, activeChatId, fullPath, rel } = params;
  if (!workspaceId || !isAtlarixPlanRelativePath(rel)) return;

  let content: string;
  try {
    content = await readFile(fullPath, "utf8");
  } catch (e) {
    logger.warn("[refreshPlanLedgerFromWrittenFile] read failed:", e);
    return;
  }

  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  const guardKey = `${workspaceId}:${rel.replace(/\\/g, "/")}`;
  const now = Date.now();
  const prev = refreshGuard.get(guardKey);
  if (prev?.hash === digest && now - prev.at < DEBOUNCE_MS) {
    logger.log(
      "[refreshPlanLedgerFromWrittenFile] skip duplicate plan body (debounced)",
    );
    return;
  }
  refreshGuard.set(guardKey, { hash: digest, at: now });

  const { parsePlanToSteps, extractPlanTitle } = await import(
    "@/lib/tasks/atlarix-plan-steps"
  );
  const steps = parsePlanToSteps(content);
  if (steps.length === 0) return;

  const {
    planLedgerTurnId,
    getLedger,
    createLedger,
    setLedgerSteps,
    persistLedgerToDisk,
  } = await import("@/lib/tasks/task-ledger");
  const { syncPlanFile } = await import("@/lib/tasks/plan-sync");
  const planTurnId = planLedgerTurnId(workspaceId);
  if (planTurnId == null) return;
  const taskHead = extractPlanTitle(content, "Implementation plan");

  const existing = getLedger(planTurnId);
  if (existing) {
    await setLedgerSteps(planTurnId, steps, { archive: false });
    const L = getLedger(planTurnId);
    if (L) {
      L.chatId = activeChatId;
      await persistLedgerToDisk(L);
      await syncPlanFile(workspacePath, L);
    }
  } else {
    createLedger({
      turnId: planTurnId,
      chatId: activeChatId,
      originalTask: taskHead,
      chatType: "workspace",
      workspacePath,
      stepDescriptions: steps,
    });
    const L = getLedger(planTurnId);
    if (L) await syncPlanFile(workspacePath, L);
  }
}
