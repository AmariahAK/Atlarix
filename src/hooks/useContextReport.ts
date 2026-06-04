import { useEffect, useState } from "react";
import { IpcClient } from "@/ipc/ipc_client";
import type { ChatContextReport } from "@/ipc/ipc_types";

/** Latest per-chat context assembly report (module cache survives remounts). */
const latestByChatId = new Map<number, ChatContextReport>();

/**
 * v10 context meter: the latest `chat:context-report` for this chat —
 * per-section token sizes plus what was trimmed/pruned at dispatch.
 */
export function useContextReport(
  chatId: number | null | undefined,
): ChatContextReport | null {
  const [report, setReport] = useState<ChatContextReport | null>(
    chatId != null ? (latestByChatId.get(chatId) ?? null) : null,
  );

  useEffect(() => {
    if (chatId == null) {
      setReport(null);
      return;
    }
    setReport(latestByChatId.get(chatId) ?? null);
    const unsubscribe = IpcClient.getInstance().onContextReport((payload) => {
      latestByChatId.set(payload.chatId, payload);
      if (payload.chatId === chatId) setReport(payload);
    });
    return unsubscribe;
  }, [chatId]);

  return report;
}
