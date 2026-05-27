import { getDefaultStore } from "jotai";
import {
  activityStreamItemsAtom,
  type ActivityStreamItem,
} from "@/atoms/sourceAtoms";

/** Activity rows visible for a given chat (includes legacy rows with no chatId). */
export function filterActivityForChat(
  items: ActivityStreamItem[],
  chatId: number,
): ActivityStreamItem[] {
  return items.filter((i) => i.chatId == null || i.chatId === chatId);
}

/** Drop activity rows scoped to `chatId`; keep other chats and unscoped rows. */
export function removeActivityForChat(
  items: ActivityStreamItem[],
  chatId: number,
): ActivityStreamItem[] {
  return items.filter((i) => i.chatId !== chatId);
}

export function clearActivityForChatInStore(chatId: number): void {
  getDefaultStore().set(activityStreamItemsAtom, (prev) =>
    removeActivityForChat(prev, chatId),
  );
}

/** True when resuming a session should keep live renderer state (no DB hydrate). */
export function shouldUseStreamingSessionFastPath(
  chatId: number | undefined,
  isStreamingById: Map<number, boolean>,
): boolean {
  if (chatId == null) return false;
  return isStreamingById.get(chatId) === true;
}
