/**
 * Guided mode: horizontal pipeline (Main → Agent cards → Main).
 * Consumes delegation events from activity stream. Emerald-themed.
 */

import React from "react";
import { useAtomValue } from "jotai";
import { activityStreamItemsAtom, type ActivityStreamItem } from "@/atoms/sourceAtoms";
import { cn } from "@/lib/utils";
import { Search, Box, Hammer, Eye, Loader2, Check, X } from "lucide-react";

const AGENT_ICONS: Record<string, React.ElementType> = {
  research: Search,
  architect: Box,
  builder: Hammer,
  reviewer: Eye,
};

function getAgentIcon(agentId: string): React.ElementType {
  const key = String(agentId).toLowerCase();
  return AGENT_ICONS[key] ?? Box;
}

export function GuidedPipeline() {
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
        <p className="text-sm">Guided pipeline</p>
        <p className="text-xs mt-1">Delegation activity will appear here.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-border bg-muted/20">
        <span className="text-xs font-medium">Guided pipeline</span>
      </div>
      <div className="flex-1 overflow-auto p-3">
        <div className="flex items-center gap-2 overflow-x-auto pb-2">
          <div className="flex shrink-0 items-center gap-1.5 rounded-lg border-2 border-emerald-500/50 bg-muted/30 px-3 py-2 text-xs font-medium">
            <span>Main</span>
          </div>
          {delegationItems.map((item, idx) => {
            const Icon = getAgentIcon(item.agent ?? "agent");
            const isActive = item.status === "running" || item.status === "active";
            const isDone = item.status === "done";
            const isError = item.status === "error";
            return (
              <React.Fragment key={item.id}>
                <div
                  className={cn(
                    "h-8 w-px shrink-0 bg-emerald-500/40",
                    isDone && "bg-emerald-500"
                  )}
                />
                <div
                  className={cn(
                    "flex shrink-0 flex-col gap-0.5 rounded-lg border-2 px-3 py-2 min-w-[120px] max-w-[180px]",
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
                      {item.task.slice(0, 40)}…
                    </p>
                  )}
                </div>
              </React.Fragment>
            );
          })}
          <div className="h-8 w-px shrink-0 bg-emerald-500/40" />
          <div className="flex shrink-0 items-center gap-1.5 rounded-lg border-2 border-emerald-500/50 bg-muted/30 px-3 py-2 text-xs font-medium">
            <span>Main</span>
          </div>
        </div>
      </div>
    </div>
  );
}
