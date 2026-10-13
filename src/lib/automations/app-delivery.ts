/**
 * The desktop app's side of agent delivery (agent-delivery.ts): a finished
 * notify-the-agent automation run wakes one of the app's chats in that folder,
 * as a finished background command or sub-agent does (owner, 2026-10-13). The
 * CLI and editor do the same from AgentSession.
 *
 * Every 15s, and as soon as a run finishes here, the app's chats that have a
 * conversation (an empty chat must not take a result) claim the unclaimed
 * finished runs in their folders. For each folder with a fresh one, the most
 * recently active chat there is woken over `chat:background-job-update`
 * (source "automation"), the channel commands, sub-agents and scheduled wakes
 * use; the renderer's wake closure keeps the guards (not while the chat is
 * busy or was stopped) and the wake turn drains the result. A run is claimed
 * once, so it can wake at most one turn.
 */
import log from "electron-log";
import { claimFinishedRuns } from "./agent-delivery";
import { PROCESS_OWNER } from "./process-owner";
import { listStreamTransports } from "@/lib/chat/stream-transport";

const logger = log.scope("automation-delivery");
const POLL_MS = 15_000;

let claiming = false;

/** Claim finished runs for the app's chats and wake one chat per folder. */
export async function deliverFinishedRunsToAppChats(
  wake: (chatId: number) => void,
): Promise<void> {
  if (claiming) return;
  claiming = true;
  try {
    const chats = listStreamTransports().filter(
      (c): c is typeof c & { appId: number } =>
        c.appId != null && c.messageCount > 0,
    );
    if (!chats.length) return;
    const got = await claimFinishedRuns(
      chats.map((c) => c.appId),
      `${PROCESS_OWNER}:app`,
    );
    for (const { workspaceId, wake: fresh } of got) {
      if (!fresh) continue; // stale: it goes into the next message there
      const target = chats
        .filter((c) => c.appId === workspaceId)
        .sort((a, b) => b.lastMessageId - a.lastMessageId)[0];
      if (target) wake(target.chatId);
    }
  } catch (e) {
    logger.warn("automation delivery failed:", e);
  } finally {
    claiming = false;
  }
}

/** Start delivering (app main only). Returns a stop function. */
export async function startAppAutomationDelivery(): Promise<() => void> {
  const { broadcastToAllWindows } = await import(
    "@/ipc/utils/broadcast_all_windows"
  );
  const { onAutomationRunFinished } = await import("./notify");
  const wake = (chatId: number) =>
    broadcastToAllWindows("chat:background-job-update", {
      chatId,
      source: "automation",
      status: "finished",
    });
  const tick = () => void deliverFinishedRunsToAppChats(wake);
  const timer = setInterval(tick, POLL_MS);
  (timer as { unref?: () => void }).unref?.();
  const off = onAutomationRunFinished(tick);
  return () => {
    clearInterval(timer);
    off();
  };
}
