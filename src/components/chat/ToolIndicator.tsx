import { useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { toolIndicatorAtom } from "@/atoms/chatAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import AtlarixAnimation from "@/components/atlarix/AtlarixAnimation";
import { ChevronDown, ChevronUp } from "lucide-react";

/**
 * v3.5: Persistent "Working…" indicator shown while the AI is executing a tool.
 * Fix: Finding 4 — also shows "Thinking…" before first token; human-readable tool labels from main.
 */
export function ToolIndicator() {
  const state = useAtomValue(toolIndicatorAtom);
  const setState = useSetAtom(toolIndicatorAtom);
  const [outputExpanded, setOutputExpanded] = useState(false);

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
          liveOutput: "",
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
            liveOutput: count > 0 ? prev.liveOutput : "",
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

  const showPhaseOnly = Boolean(state.phaseLabel) && !state.active;
  const showToolRow = state.active && Boolean(state.toolName);
  if (!showPhaseOnly && !showToolRow) return null;

  const displayLine = showToolRow
    ? `Working… ${state.toolName}`
    : (state.phaseLabel ?? "");

  const showLiveOutput =
    state.liveOutput.length > 0 &&
    showToolRow &&
    /\bcommand\b/i.test(state.toolName ?? "");

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
            {outputExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            <span>{outputExpanded ? "Hide output" : "Show output"}</span>
          </button>
          {outputExpanded && (
            <pre className="px-3 py-2 max-h-40 overflow-auto text-xs font-mono bg-background/50 whitespace-pre-wrap break-words border-t border-border">
              {state.liveOutput || "(no output yet)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
