/**
 * Finished automation runs, delivered to the agent's next turn.
 *
 * Mirrors `lib/agents/subagent-results.ts` and rides the same channel: results
 * are drained by `collectPendingBackgroundResultsBody`, so they arrive as a real
 * tool result on a continuation turn rather than as a transient injection — a
 * channel weak and open-weight models are trained to consume and cannot skip.
 *
 * THE GATE IS `notifyAgent`, AND IT IS CHECKED BY THE CALLER, NOT HERE.
 * `recordAutomationResult` is only ever called for an automation whose
 * `notifyAgent` is true. That is what makes "watch Slack" and "watch CI"
 * genuinely different kinds of thing rather than the same thing at different
 * intervals: an automation the user chose not to share with the agent cannot
 * cost a single token, no matter how often it fires or how noisy it is.
 *
 * Deliberately does NOT wake a turn. A result lands in the NEXT turn the user
 * starts, honouring the v14.23.0 rule that background work never re-animates a
 * turn the user stopped. The user is separately notified by the existing feed +
 * OS notification path, which is what they act on.
 *
 * KEYED BY WORKSPACE, NOT BY CHAT — the one structural difference from
 * sub-agent results. A sub-agent is spawned FROM a chat and belongs to it; an
 * automation fires on a timer with no conversation in view, and the chat the
 * user will next open does not exist yet when the run finishes. So results
 * accumulate per workspace and are drained by whichever chat in that workspace
 * next takes a turn. `chatId → workspaceId` resolves through the same stream
 * transport the rest of the turn machinery uses.
 */

import { getStreamTransportAppId } from "@/lib/chat/stream-transport";

const BODY_TAIL_CAP = 8_000;
const MAX_QUEUED_PER_CHAT = 10;

export type AutomationResult = {
  automationId: string;
  automationName: string;
  status: "ok" | "nothing-to-report" | "error";
  /** Run summary, or the error text. */
  body: string;
  finishedAt: number;
};

const resultsByWorkspace = new Map<number, AutomationResult[]>();

/** The workspace a chat belongs to, or null when it cannot be resolved. */
function workspaceForChat(chatId: number): number | null {
  try {
    return getStreamTransportAppId(chatId) ?? null;
  } catch {
    return null;
  }
}

export function recordAutomationResult(
  workspaceId: number,
  result: AutomationResult,
): void {
  const list = resultsByWorkspace.get(workspaceId) ?? [];
  list.push({
    ...result,
    body: result.body.slice(-BODY_TAIL_CAP),
  });
  // Oldest first out: a chat that has been closed for a week should deliver the
  // most recent state of a watch, not the start of its backlog.
  while (list.length > MAX_QUEUED_PER_CHAT) list.shift();
  resultsByWorkspace.set(workspaceId, list);
}

export function hasPendingAutomationResults(chatId: number): boolean {
  const ws = workspaceForChat(chatId);
  if (ws == null) return false;
  return (resultsByWorkspace.get(ws)?.length ?? 0) > 0;
}

/** Take-once: draining here is what stops a second consumer re-delivering. */
export function takePendingAutomationResults(chatId: number): string | null {
  const ws = workspaceForChat(chatId);
  if (ws == null) return null;
  const list = resultsByWorkspace.get(ws);
  if (!list || list.length === 0) return null;
  resultsByWorkspace.delete(ws);

  const blocks = list.map((r) => {
    const head = `AUTOMATION "${r.automationName}" (${r.status})`;
    return `${head}\n${r.body.trim() || "(no detail)"}`;
  });
  return [
    "A background automation you or the user set up has finished.",
    "You were told because it is set to notify you — decide whether it needs action, and say so plainly if it does not.",
    "",
    ...blocks,
  ].join("\n");
}

/** Test seam — module state would otherwise leak between cases. */
export function clearAutomationResultsForTests(): void {
  resultsByWorkspace.clear();
}
