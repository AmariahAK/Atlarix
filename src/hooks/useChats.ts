import { useSetAtom } from "jotai";
import { workspaceSessionsRefreshAtom } from "@/atoms/sessionAtoms";
import type { ChatSummary } from "@/lib/schemas";

/** @deprecated Legacy DB chat list — use workspace session list instead. */
export function useChats(_appId: number | null) {
  const bumpSessions = useSetAtom(workspaceSessionsRefreshAtom);

  const refreshChats = async (): Promise<ChatSummary[]> => {
    bumpSessions((n) => n + 1);
    return [];
  };

  return { chats: [] as ChatSummary[], loading: false, refreshChats };
}
