import { getDefaultStore } from "jotai";
import { IpcClient } from "@/ipc/ipc_client";
import { workspaceSessionsRefreshAtom } from "@/atoms/sessionAtoms";
import { generateSimpleChatName } from "@/utils/chat_naming";

const DEFAULT_SESSION_TITLE = "New session";

/** Instant title from the first user message (before AI naming). */
export async function titleWorkspaceSessionFromUserMessage(
  sessionId: string,
  userMessage: string,
): Promise<void> {
  const title = generateSimpleChatName(userMessage);
  if (!title || title === "New chat" || title === DEFAULT_SESSION_TITLE) return;
  try {
    await IpcClient.getInstance().renameWorkspaceSession(sessionId, title);
    getDefaultStore().set(workspaceSessionsRefreshAtom, (n) => n + 1);
  } catch (e) {
    console.error("Failed to title workspace session:", e);
  }
}

/** AI-generated title after the first assistant reply (summarization model). */
export async function generateWorkspaceSessionTitleWithAI(
  sessionId: string,
): Promise<void> {
  try {
    const result =
      await IpcClient.getInstance().generateWorkspaceSessionTitle(sessionId);
    if (result?.title) {
      getDefaultStore().set(workspaceSessionsRefreshAtom, (n) => n + 1);
    }
  } catch (e) {
    console.error("Failed to generate AI workspace session title:", e);
  }
}
