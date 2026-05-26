import { useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { summarizationProgressAtom } from "@/atoms/chatAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import AtlarixAnimation from "@/components/atlarix/AtlarixAnimation";

const SUMMARIZATION_LABELS = new Set([
  "Summarizing conversation",
  "Summarizing tool outputs",
]);

const FAILSAFE_MS = 45_000;

/**
 * Shows animated status above the chat input when context or tool-output
 * summarization is running (post-turn compression, compaction, etc.).
 *
 * Summarization runs after the model stream ends, so we must not gate on
 * `isStreamingById` (that caused clear/re-show update loops).
 */
export function SummarizationProgressStrip() {
  const progress = useAtomValue(summarizationProgressAtom);
  const setProgress = useSetAtom(summarizationProgressAtom);
  const failsafeRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsub = IpcClient.getInstance().onChatActivity((payload) => {
      const label = payload?.label ?? "";
      if (!SUMMARIZATION_LABELS.has(label)) return;
      if (payload.status === "running") {
        setProgress({
          active: true,
          chatId: payload.chatId ?? null,
          label,
        });
      } else if (payload.status === "done") {
        setProgress({ active: false, chatId: null, label: undefined });
      }
    });
    return unsub;
  }, [setProgress]);

  useEffect(() => {
    if (failsafeRef.current) {
      clearTimeout(failsafeRef.current);
      failsafeRef.current = null;
    }
    if (!progress.active) return;

    failsafeRef.current = setTimeout(() => {
      setProgress((prev) =>
        prev.active
          ? { active: false, chatId: null, label: undefined }
          : prev,
      );
    }, FAILSAFE_MS);

    return () => {
      if (failsafeRef.current) clearTimeout(failsafeRef.current);
    };
  }, [progress.active, setProgress]);

  useEffect(() => {
    const unsub = IpcClient.getInstance().onStreamPhase(({ chatId, phase }) => {
      if (phase !== "done") return;
      setProgress((prev) => {
        if (!prev.active || prev.chatId !== chatId) return prev;
        return { active: false, chatId: null, label: undefined };
      });
    });
    return unsub;
  }, [setProgress]);

  if (!progress.active) return null;

  const displayLabel =
    progress.label === "Summarizing tool outputs"
      ? "Summarizing tool outputs…"
      : "Summarizing conversation…";

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 text-left text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <div className="shrink-0">
        <AtlarixAnimation size="xs" phase="thinking" />
      </div>
      <span className="animate-pulse">{displayLabel}</span>
    </div>
  );
}
