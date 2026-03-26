/**
 * v2.1: Activity Stream - real-time feedback for AI operations.
 * Shows model selection, delegation, self-review, compaction, tool use.
 * No emojis; Lucide icons only (Loader2, Check, X, Bot, Search, etc.).
 */

import { useAtom, useAtomValue } from "jotai";
import { useEffect, useCallback } from "react";
import {
  activityStreamItemsAtom,
  type ActivityStreamItem,
} from "@/atoms/sourceAtoms";
import { useAgentAnimStore, type AgentId } from "@/lib/agents/animation-state";
import { cn } from "@/lib/utils";
import {
  Bot,
  Search,
  Box,
  Hammer,
  Eye,
  Loader2,
  Check,
  X,
  Activity,
  FileText,
} from "lucide-react";

const TYPE_ICONS: Record<string, React.ElementType> = {
  model_selection: Bot,
  delegation: Box,
  delegation_start: Box,
  delegation_complete: Box,
  delegation_error: Box,
  self_review: Eye,
  background: FileText,
  tool_use: Hammer,
  turn_summary: Activity,
  mode_change: Activity,
  agent_message: Box,
  routing_decision: Bot,
};

const STATUS_ICONS: Record<string, React.ElementType> = {
  running: Loader2,
  active: Loader2,
  done: Check,
  error: X,
};

export function ActivityStream() {
  const [items, setItems] = useAtom(activityStreamItemsAtom);

  const handleActivity = useCallback(
    (_: unknown, payload: ActivityStreamItem & { type?: string; status?: string }) => {
      setItems((prev) => {
        const next = [...prev];
        const idx = next.findIndex((i) => i.id === payload.id);
        const normalized = { ...payload } as ActivityStreamItem;
        if (payload.status === "active") normalized.status = "running";
        if (idx >= 0) {
          next[idx] = { ...next[idx], ...normalized };
        } else {
          next.push(normalized);
        }
        return next.slice(-100);
      });
      // v3.6: Sync agent animation store for agent canvas
      const agent = payload.agent as string | undefined;
      const agentIds: AgentId[] = [
        "main",
        "architect",
        "builder",
        "reviewer",
        "researcher",
        "debugger",
      ];
      if (agent && agentIds.includes(agent as AgentId)) {
        const store = useAgentAnimStore.getState();
        const aid = agent as AgentId;
        if (payload.type === "delegation_start") {
          store.setAgentState(aid, "delegating");
          store.startFlow({
            id: payload.id,
            from: aid,
            to: aid,
            type: "request",
            startedAt: payload.timestamp ?? Date.now(),
          });
        } else if (payload.type === "delegation_complete" || payload.type === "delegation_error") {
          store.endFlow(payload.id);
          store.setAgentState(aid, "idle");
        }
      }
    },
    [setItems]
  );

  const handleClear = useCallback(() => {
    setItems([]);
  }, [setItems]);

  useEffect(() => {
    const unsub =
      typeof window !== "undefined" &&
      (window as any).electron?.ipcRenderer?.on(
        "chat:activity",
        handleActivity
      );
    return () => {
      if (typeof unsub === "function") unsub();
    };
  }, [handleActivity]);

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-6 text-center">
        <Activity className="w-12 h-12 mb-3 opacity-50" />
        <p className="text-sm">Activity stream</p>
        <p className="text-xs mt-1">
          Model selection, delegation, and tool use will appear here as you chat.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/20">
        <span className="text-xs font-medium">Activity</span>
        <button
          type="button"
          onClick={handleClear}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Clear
        </button>
      </div>
      <ul className="flex-1 overflow-auto p-2 space-y-1">
        {items.map((item) => {
          const TypeIcon = TYPE_ICONS[item.type] ?? Bot;
          const StatusIcon = STATUS_ICONS[item.status];
          return (
            <li
              key={item.id}
              className={cn(
                "flex items-start gap-2 rounded-md px-2 py-1.5 text-xs",
                item.status === "error" && "bg-destructive/10 text-destructive",
                item.status === "done" && "text-muted-foreground"
              )}
            >
              <TypeIcon className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-foreground truncate">
                  {item.label}
                </div>
                {item.detail && (
                  <div className="text-muted-foreground truncate mt-0.5">
                    {item.detail}
                  </div>
                )}
                {(item.tokens != null || item.cost != null) && (
                  <div className="text-muted-foreground mt-0.5">
                    {item.tokens != null && `${item.tokens} tokens`}
                    {item.tokens != null && item.cost != null && " · "}
                    {item.cost != null && `$${item.cost.toFixed(4)}`}
                  </div>
                )}
              </div>
              <StatusIcon
                className={cn(
                  "h-3.5 w-3.5 shrink-0 mt-0.5",
                  item.status === "running" && "animate-spin text-primary",
                  item.status === "done" && "text-green-600",
                  item.status === "error" && "text-destructive"
                )}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
