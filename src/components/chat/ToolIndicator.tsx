import { useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { toolIndicatorAtom } from "@/atoms/chatAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import AtlarixAnimation from "@/components/atlarix/AtlarixAnimation";
import { ChevronDown, ChevronUp } from "lucide-react";

export type ToolIndicatorProps = {
  /** When set, only show status for this chat (avoids wrong session in multi-chat UIs). */
  forChatId?: number;
};

/**
 * v3.5: Persistent "Working…" indicator shown while the AI is executing a tool.
 * Fix: Finding 4 — also shows "Thinking…" before first token; human-readable tool labels from main.
 */
export function ToolIndicator({ forChatId }: ToolIndicatorProps = {}) {
  const state = useAtomValue(toolIndicatorAtom);
  const setState = useSetAtom(toolIndicatorAtom);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [viewMode, setViewMode] = useState<
    "error_first" | "progress_first" | "raw_capped"
  >("error_first");

  useEffect(() => {
    const unsub = IpcClient.getInstance().onToolIndicator(
      ({ chatId, toolName }) => {
        setState((prev) => ({
          ...prev,
          active: true,
          toolName,
          phaseLabel: null,
          count: prev.count + 1,
          activeChatId: chatId,
          liveOutputLines: [],
          liveErrorLines: [],
          liveProgressLines: [],
          liveViewMode: "error_first",
        }));
      },
      () => {
        setState((prev) => {
          const count = Math.max(0, prev.count - 1);
          return {
            ...prev,
            count,
            active: count > 0,
            toolName: count > 0 ? prev.toolName : null,
            activeChatId: count > 0 ? prev.activeChatId : null,
            liveOutputLines: count > 0 ? prev.liveOutputLines : [],
            liveErrorLines: count > 0 ? prev.liveErrorLines : [],
            liveProgressLines: count > 0 ? prev.liveProgressLines : [],
          };
        });
      },
    );
    return unsub;
  }, [setState]);

  // Fix: Finding 4
  useEffect(() => {
    const unsub = IpcClient.getInstance().onStreamPhase(({ chatId, phase, label }) => {
      setState((prev) => {
        if (phase === "thinking") {
          return {
            ...prev,
            phaseLabel: label.trim() || "Thinking…",
            activeChatId: chatId,
          };
        }
        if (phase === "responding") {
          if (prev.activeChatId !== chatId) return prev;
          return { ...prev, phaseLabel: null };
        }
        return prev;
      });
    });
    return unsub;
  }, [setState]);

  if (
    forChatId !== undefined &&
    state.activeChatId !== null &&
    state.activeChatId !== forChatId
  ) {
    return null;
  }

  const showToolRow = state.active && Boolean(state.toolName);
  if (!showToolRow) return null;

  const displayLine = `Working… ${state.toolName}`;

  const showLiveOutput = showToolRow && state.liveOutputLines.length > 0;

  const effectiveMode = viewMode ?? state.liveViewMode ?? "error_first";
  const lines =
    effectiveMode === "raw_capped"
      ? state.liveOutputLines
      : effectiveMode === "progress_first"
        ? state.liveProgressLines
        : state.liveErrorLines.length > 0
          ? state.liveErrorLines
          : state.liveOutputLines;
  const text = lines.join("\n");

  return (
    <div className="rounded-lg border border-border bg-muted/50 text-muted-foreground text-sm overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="shrink-0">
          <AtlarixAnimation size="xs" phase="thinking" />
        </div>
        <span className="flex-1 font-medium">{displayLine}</span>
      </div>
      {showLiveOutput && (
        <div className="border-t border-border">
          <button
            type="button"
            onClick={() => setOutputExpanded((e) => !e)}
            className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-xs hover:bg-muted/50"
          >
            <div className="flex items-center gap-2">
              {outputExpanded ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              <span>{outputExpanded ? "Hide output" : "Show output"}</span>
            </div>
            <div className="flex items-center gap-1">
              {(["error_first", "progress_first", "raw_capped"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setViewMode(m);
                  }}
                  className={`rounded px-2 py-0.5 text-[10px] border ${viewMode === m ? "bg-muted text-foreground border-border" : "border-border text-muted-foreground hover:text-foreground"}`}
                  title={m === "error_first" ? "Errors" : m === "progress_first" ? "Progress" : "Raw"}
                >
                  {m === "error_first" ? "Errors" : m === "progress_first" ? "Progress" : "Raw"}
                </button>
              ))}
            </div>
          </button>
          {outputExpanded && (
            <pre className="px-3 py-2 max-h-40 overflow-auto text-xs font-mono bg-background/50 whitespace-pre-wrap break-words border-t border-border">
              {text || "(no output yet)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
