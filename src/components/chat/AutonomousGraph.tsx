/**
 * Autonomous mode: 2D graph (Main → agents → sub-agents).
 * Consumes same delegation events; builds tree from id, parentId, depth.
 * Emerald-themed with agent icon colors.
 */

import React from "react";
import { useAtomValue } from "jotai";
import { activityStreamItemsAtom, type ActivityStreamItem } from "@/atoms/sourceAtoms";
import { cn } from "@/lib/utils";
import { Search, Box, Hammer, Eye, Loader2, Check, X, Bot } from "lucide-react";

const AGENT_ICONS: Record<string, React.ElementType> = {
  research: Search,
  architect: Box,
  builder: Hammer,
  reviewer: Eye,
};

function getAgentIcon(agentId: string): React.ElementType {
  const key = String(agentId).toLowerCase();
  return AGENT_ICONS[key] ?? Bot;
}

export function AutonomousGraph() {
  const items = useAtomValue(activityStreamItemsAtom);
  const delegationRaw = items.filter(
    (i) =>
      i.type === "delegation_start" ||
      i.type === "delegation_complete" ||
      i.type === "delegation_error" ||
      (i.type === "delegation" && i.id)
  );
  const byId = new Map<string, ActivityStreamItem>();
  for (const i of delegationRaw) {
    byId.set(i.id, i);
  }
  const delegationItems = Array.from(byId.values()).sort(
    (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)
  );

  if (delegationItems.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-6 text-center">
        <p className="text-sm">Autonomous graph</p>
        <p className="text-xs mt-1">Delegation activity will appear here.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-border bg-muted/20">
        <span className="text-xs font-medium">Autonomous graph</span>
      </div>
      <div className="flex-1 overflow-auto p-3">
        <div className="flex flex-col gap-3">
          <div className="flex shrink-0 items-center gap-2 rounded-lg border-2 border-emerald-500/50 bg-muted/30 px-3 py-2 text-xs font-medium w-fit">
            <Bot className="h-4 w-4" />
            Main
          </div>
          <div className="flex flex-col gap-2 pl-4 border-l-2 border-emerald-500/40">
            {delegationItems.map((item) => {
              const Icon = getAgentIcon(item.agent ?? "agent");
              const isActive = item.status === "running" || item.status === "active";
              const isDone = item.status === "done";
              const isError = item.status === "error";
              return (
                <div
                  key={item.id}
                  className={cn(
                    "flex flex-col gap-0.5 rounded-lg border-2 px-3 py-2 max-w-[220px]",
                    isActive && "border-emerald-500 animate-pulse bg-emerald-500/10",
                    isDone && "border-emerald-600 bg-emerald-500/5",
                    isError && "border-destructive/50 bg-destructive/5"
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="truncate text-xs font-medium">
                      {(item.agent ?? "agent").replace(/^./, (c) => c.toUpperCase())}
                    </span>
                    {isActive && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
                    {isDone && <Check className="h-3 w-3 shrink-0 text-emerald-600" />}
                    {isError && <X className="h-3 w-3 shrink-0 text-destructive" />}
                  </div>
                  {item.task && (
                    <p className="text-[10px] text-muted-foreground truncate" title={item.task}>
                      {item.task.slice(0, 50)}…
                    </p>
                  )}
                  {item.duration != null && (
                    <p className="text-[10px] text-muted-foreground">{item.duration}ms</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
