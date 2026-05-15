import { useEffect, useRef, useState } from "react";
import { IpcClient } from "@/ipc/ipc_client";
import AtlarixAnimation from "@/components/atlarix/AtlarixAnimation";

/**
 * FIX 6: Compaction status banner shown above the chat input box.
 *
 * Subscribes to raw `chat:activity` IPC events of `type: "compaction"`
 * emitted by `chat_stream_handlers.ts` whenever `runMidLoopCompaction`
 * fires for the current chat. Without this banner the input area went
 * silent during mid-task compaction — the model appeared to hang for
 * 5-30 seconds while the summarizer worked.
 *
 * Mirrors `SummarizationProgressStrip` (raw IPC pattern, NOT routed
 * through `chat-activity-normalize.ts`) so the spec-mandated
 * `type: "compaction"` events don't need to be added to the
 * `ActivityStreamItem` union.
 *
 * UX:
 *  - running  → "Compressing context…" with pulse
 *  - done     → "Resuming…" for 1.5s, then hide
 *
 * Token-bar pulse is driven separately by `useCompactionTokenVisuals`
 * which consumes the original `type: "background"` events. The two
 * indicators are complementary.
 */
interface CompactionProgressStripProps {
  chatId: number;
}

export function CompactionProgressStrip({ chatId }: CompactionProgressStripProps) {
  const [phase, setPhase] = useState<"hidden" | "running" | "resuming">("hidden");
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsub = IpcClient.getInstance().onChatActivity((rawPayload) => {
      // `onChatActivity`'s public signature is intentionally narrow
      // (`label/status/chatId`). The full payload also carries `type`,
      // which we need here to distinguish compaction events from
      // unrelated activity. Cast to the richer shape.
      const payload = rawPayload as {
        type?: string;
        label?: string;
        status?: string;
        chatId?: number;
      };
      if (!payload || payload.type !== "compaction") return;
      if (payload.chatId != null && payload.chatId !== chatId) return;

      if (payload.status === "running") {
        if (resumeTimerRef.current) {
          clearTimeout(resumeTimerRef.current);
          resumeTimerRef.current = null;
        }
        setPhase("running");
      } else if (payload.status === "done") {
        setPhase("resuming");
        if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
        resumeTimerRef.current = setTimeout(() => {
          setPhase("hidden");
          resumeTimerRef.current = null;
        }, 1500);
      }
    });
    return () => {
      unsub();
      if (resumeTimerRef.current) {
        clearTimeout(resumeTimerRef.current);
        resumeTimerRef.current = null;
      }
    };
  }, [chatId]);

  if (phase === "hidden") return null;

  const label =
    phase === "running"
      ? "Compressing context…"
      : "Context compressed — resuming…";

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 text-left text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <div className="shrink-0">
        <AtlarixAnimation size="xs" phase="thinking" />
      </div>
      <span className={phase === "running" ? "animate-pulse" : undefined}>
        {label}
      </span>
    </div>
  );
}
