import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { summarizationProgressAtom } from "@/atoms/chatAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import AtlarixAnimation from "@/components/atlarix/AtlarixAnimation";

/**
 * v3.5: Shows "Summarizing…" with compass animation above the chat input (left-aligned)
 * when context compaction is running. Listens to chat:activity for "Summarizing conversation".
 */
export function SummarizationProgressStrip() {
  const progress = useAtomValue(summarizationProgressAtom);
  const setProgress = useSetAtom(summarizationProgressAtom);

  useEffect(() => {
    const unsub = IpcClient.getInstance().onChatActivity((payload) => {
      if (payload?.label === "Summarizing conversation") {
        if (payload.status === "running") {
          setProgress({ active: true, chatId: payload.chatId ?? null });
        } else if (payload.status === "done") {
          setProgress({ active: false, chatId: null });
        }
      }
    });
    return unsub;
  }, [setProgress]);

  if (!progress.active) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-left text-sm text-muted-foreground">
      <div className="shrink-0">
        <AtlarixAnimation size="xs" phase="thinking" />
      </div>
      <span>Summarizing…</span>
    </div>
  );
}
