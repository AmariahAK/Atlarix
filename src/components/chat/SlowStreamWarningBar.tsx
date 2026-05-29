import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { useAtomValue, useSetAtom, getDefaultStore } from "jotai";
import {
  activeTurnScopeAtom,
  streamLastActivityAtByChatIdAtom,
  streamSlowWarningByChatIdAtom,
} from "@/atoms/chatAtoms";
import { useSettings } from "@/hooks/useSettings";
import { IpcClient } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";

/** Turn has run long enough that large tool args / slow models may be the cause. */
const LONG_TASK_MS = 3 * 60 * 1000;
/** No stream chunks at all (true hang). */
const STREAM_STALL_MS = 5 * 60 * 1000;

export function SlowStreamWarningBar({
  chatId,
  isStreaming,
  requireBuildMode = true,
}: {
  chatId?: number | null;
  isStreaming: boolean;
  /** When false, show for any chat mode (workspace inline chat). */
  requireBuildMode?: boolean;
}) {
  const { settings } = useSettings();
  const setSlow = useSetAtom(streamSlowWarningByChatIdAtom);
  const slowMap = useAtomValue(streamSlowWarningByChatIdAtom);

  useEffect(() => {
    if (!isStreaming || chatId == null) return;
    if (requireBuildMode && settings?.selectedChatMode !== "build") return;

    const tick = window.setInterval(() => {
      const turn = getDefaultStore().get(activeTurnScopeAtom);
      const turnAgeMs =
        turn?.chatId === chatId ? Date.now() - turn.startedAt : null;

      const lastActivity = getDefaultStore()
        .get(streamLastActivityAtByChatIdAtom)
        .get(chatId);
      const stallAgeMs =
        lastActivity != null ? Date.now() - lastActivity : null;

      const isLongTask = turnAgeMs != null && turnAgeMs >= LONG_TASK_MS;
      const isStalled = stallAgeMs != null && stallAgeMs >= STREAM_STALL_MS;

      if (isLongTask || isStalled) {
        setSlow((prev) => {
          const n = new Map(prev);
          n.set(chatId, true);
          return n;
        });
      }
    }, 5_000);

    return () => clearInterval(tick);
  }, [
    isStreaming,
    chatId,
    requireBuildMode,
    settings?.selectedChatMode,
    setSlow,
  ]);

  useEffect(() => {
    if (!isStreaming && chatId != null) {
      setSlow((prev) => {
        if (!prev.has(chatId)) return prev;
        const n = new Map(prev);
        n.delete(chatId);
        return n;
      });
    }
  }, [isStreaming, chatId, setSlow]);

  if (chatId == null || !slowMap.get(chatId)) return null;

  return (
    <div
      role="status"
      className="mx-0 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-950 dark:text-amber-100 flex flex-wrap items-start gap-2"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
      <div className="flex-1 min-w-[12rem] space-y-1">
        <p className="font-medium leading-snug">This appears to be a long task</p>
        <p className="text-xs leading-relaxed opacity-90">
          The model may still be working (for example streaming a large file write).
          If it feels stuck, try a different provider or model for faster completion,
          or stop and retry with a smaller change.
        </p>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-amber-950/80 dark:text-amber-100/80"
          onClick={() => {
            setSlow((prev) => {
              const n = new Map(prev);
              n.delete(chatId);
              return n;
            });
          }}
        >
          Dismiss
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 border-amber-600/50"
          onClick={() => {
            IpcClient.getInstance().cancelChatStream(chatId);
            setSlow((prev) => {
              const n = new Map(prev);
              n.delete(chatId);
              return n;
            });
          }}
        >
          Stop
        </Button>
      </div>
    </div>
  );
}
