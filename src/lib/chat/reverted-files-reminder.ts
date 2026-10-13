import { getDefaultStore } from "jotai";
import {
  chatMessagesByIdAtom,
  turnSnapshotTurnIdByMessageIdAtom,
} from "@/atoms/chatAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { restoredFilesNote } from "./restored-files-note";

/**
 * The user's next message after a Revert on a reply (files only, the chat
 * stays): the agent is told which files went back, once, so it does not build
 * on edits that are gone. Only the MODEL's copy carries it; the bubble shows
 * what the user typed. Same note as the CLI and editor's files-only restore.
 */
export async function withRevertedFilesNote(
  chatId: number,
  prompt: string,
): Promise<string> {
  const store = getDefaultStore();
  const snapshots = store.get(turnSnapshotTurnIdByMessageIdAtom);
  const turnIds = (store.get(chatMessagesByIdAtom).get(chatId) ?? [])
    .filter((m) => m.role === "assistant")
    .map((m) => snapshots.get(m.id))
    .filter((t): t is string => !!t);
  if (turnIds.length === 0) return prompt;
  const files = await IpcClient.getInstance()
    .takeRevertedFiles({ chatId, turnIds })
    .catch(() => [] as string[]);
  if (files.length === 0) return prompt;
  return `<system-reminder>${restoredFilesNote(files)}</system-reminder>\n\n${prompt}`;
}
