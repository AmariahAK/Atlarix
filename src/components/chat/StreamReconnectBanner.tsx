import { useEffect } from "react";
import { useAtom } from "jotai";
import { RotateCw, ArrowRight, AlertTriangle } from "lucide-react";
import { streamReconnectByChatIdAtom } from "@/atoms/chatAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { useStreamChat } from "@/hooks/useStreamChat";

/**
 * FIX 4: stream disconnect / reconnect banner.
 *
 * Shown above the chat input after the backend's silent retry sequence
 * (2s/5s/10s) has exhausted itself. Offers two recovery paths:
 *
 *  - [Reconnect] re-dispatches the exact same `chat:stream` request via
 *    `chat:stream:reconnect`. Backend emits `chat:stream:reset-partial`
 *    first so the renderer clears its in-flight assistant buffer.
 *
 *  - [Continue] sends a fresh user message containing the partial response
 *    and a short note asking the model to resume from where it left off.
 *
 * Auto-dismisses the moment a fresh `chat:response:chunk` arrives for this
 * chat (reconnect worked) or the user starts typing a new message (handled
 * by `ChatInput` clearing the atom).
 *
 * User-initiated aborts (Stop button → `chat:cancel`/`chat:abort`) never
 * surface this banner — the backend's retry wrapper short-circuits on
 * `signal.aborted` before emitting `chat:stream:disconnected`.
 */
interface StreamReconnectBannerProps {
  chatId: number;
}

export function StreamReconnectBanner({ chatId }: StreamReconnectBannerProps) {
  const [reconnectMap, setReconnectMap] = useAtom(streamReconnectByChatIdAtom);
  const { streamMessage } = useStreamChat();
  const entry = reconnectMap.get(chatId);

  useEffect(() => {
    const ipc = window.electron?.ipcRenderer;
    if (!ipc) return;

    const offDisconnected = ipc.on(
      "chat:stream:disconnected",
      (payload: unknown) => {
        if (!payload || typeof payload !== "object") return;
        const p = payload as {
          chatId?: number;
          partialResponse?: string;
          reason?: "network" | "timeout" | "provider_error";
        };
        if (p.chatId !== chatId) return;
        setReconnectMap((prev) => {
          const next = new Map(prev);
          next.set(chatId, {
            partialResponse: p.partialResponse ?? "",
            reason: p.reason ?? "network",
          });
          return next;
        });
      },
    );

    const offChunk = ipc.on("chat:response:chunk", (payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const p = payload as { chatId?: number };
      if (p.chatId !== chatId) return;
      setReconnectMap((prev) => {
        if (!prev.has(chatId)) return prev;
        const next = new Map(prev);
        next.delete(chatId);
        return next;
      });
    });

    return () => {
      offDisconnected?.();
      offChunk?.();
    };
  }, [chatId, setReconnectMap]);

  if (!entry) return null;

  const dismiss = () => {
    setReconnectMap((prev) => {
      if (!prev.has(chatId)) return prev;
      const next = new Map(prev);
      next.delete(chatId);
      return next;
    });
  };

  const handleReconnect = async () => {
    try {
      await IpcClient.getInstance().reconnectStream(chatId);
      // Banner auto-dismisses on the first incoming chunk.
    } catch (err) {
      console.error("[StreamReconnectBanner] reconnect failed:", err);
    }
  };

  const handleContinue = () => {
    const partial = entry.partialResponse.trim();
    const continuationPrompt = partial
      ? `Your previous response was interrupted. Here is what you said so far:\n\n${partial}\n\nPlease continue from where you left off.`
      : "Your previous response was interrupted before any text was emitted. Please retry your previous response.";
    void streamMessage({
      prompt: continuationPrompt,
      chatId,
      redo: false,
    });
    dismiss();
  };

  return (
    <div
      className="mx-3 my-1 flex items-center gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-200"
      role="status"
      aria-live="polite"
    >
      <AlertTriangle className="size-4 shrink-0" />
      <span className="flex-1">Connection lost.</span>
      <button
        type="button"
        onClick={handleReconnect}
        className="inline-flex items-center gap-1 rounded border border-amber-500/40 px-2 py-1 text-xs font-medium hover:bg-amber-500/20"
      >
        <RotateCw className="size-3" />
        Reconnect
      </button>
      <button
        type="button"
        onClick={handleContinue}
        className="inline-flex items-center gap-1 rounded border border-amber-500/40 px-2 py-1 text-xs font-medium hover:bg-amber-500/20"
      >
        <ArrowRight className="size-3" />
        Continue
      </button>
    </div>
  );
}
