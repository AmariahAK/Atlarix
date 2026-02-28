import { useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { toolIndicatorAtom } from "@/atoms/chatAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import AtlarixAnimation from "@/components/atlarix/AtlarixAnimation";
import { ChevronDown, ChevronUp } from "lucide-react";

/**
 * v3.5: Persistent "Working…" indicator shown while the AI is executing a tool.
 * When run_command is active, live terminal output can be shown in an expandable block.
 */
export function ToolIndicator() {
  const state = useAtomValue(toolIndicatorAtom);
  const setState = useSetAtom(toolIndicatorAtom);
  const [outputExpanded, setOutputExpanded] = useState(false);

  useEffect(() => {
    const unsub = IpcClient.getInstance().onToolIndicator(
      ({ chatId, toolName }) => {
        setState((prev) => ({
          active: true,
          toolName,
          count: prev.count + 1,
          activeChatId: chatId,
          liveOutput: "", // reset so we show output for the current tool run
        }));
      },
      () => {
        setState((prev) => {
          const count = Math.max(0, prev.count - 1);
          return {
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

  if (!state.active || !state.toolName) return null;

  const showLiveOutput = state.liveOutput.length > 0 && (state.toolName === "run_command" || state.toolName === "execute_command");

  return (
    <div className="rounded-lg border border-border bg-muted/50 text-muted-foreground text-sm overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="shrink-0">
          <AtlarixAnimation size="xs" phase="thinking" />
        </div>
        <span className="flex-1">
          Working… <span className="font-medium">{state.toolName}</span>
        </span>
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
