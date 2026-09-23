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
      // Two report kinds interleave per dispatch: the sections/trim report (for
      // the tooltip) and the dispatched-size report (the headline number). Merge
      // so neither clobbers the other — keep prior sections when a payload omits
      // them, and the prior dispatched size when a payload omits it.
      const prev = latestByChatId.get(payload.chatId);
      const merged: ChatContextReport = {
        chatId: payload.chatId,
        sections: payload.sections.length
          ? payload.sections
          : (prev?.sections ?? []),
        trimReport: payload.trimReport.length
          ? payload.trimReport
          : (prev?.trimReport ?? []),
        dispatchedTokens: payload.dispatchedTokens ?? prev?.dispatchedTokens,
        contextWindow: payload.contextWindow ?? prev?.contextWindow,
      };
      latestByChatId.set(payload.chatId, merged);
      if (payload.chatId === chatId) setReport(merged);
    });
    return unsubscribe;
  }, [chatId]);

  // useState only initialises on mount, so for the one render between a chat
  // switch and the effect above, `report` still belongs to the previous chat.
  return report?.chatId === chatId ? report : null;
}
