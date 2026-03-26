/**
 * Guided mode: Agent animation — centre Main with data flow to/from agent nodes in an arc.
 * Pillars/icons with agent names only; data motion to agent when active, back to Main when done.
 */

import React, { useMemo } from "react";
import { useAtomValue } from "jotai";
import { activityStreamItemsAtom, type ActivityStreamItem } from "@/atoms/sourceAtoms";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { Search, Box, Hammer, Eye, Loader2, Check, X, Bot, Bug } from "lucide-react";

const AGENT_IDS = ["research", "architect", "builder", "debugger", "reviewer"] as const;
const AGENT_ICONS: Record<string, React.ElementType> = {
  research: Search,
  architect: Box,
  builder: Hammer,
  debugger: Bug,
  reviewer: Eye,
};

function getAgentIcon(agentId: string): React.ElementType {
  const key = String(agentId).toLowerCase();
  return AGENT_ICONS[key] ?? Box;
}

function getAgentLabel(agentId: string): string {
  return (agentId ?? "agent").replace(/^./, (c) => c.toUpperCase());
}

/** Arc layout: 4 agents on a semi-circle. Positions as % of container (left, top). */
const ARC_POSITIONS = [
  { id: "research", left: 8, top: 14 },
  { id: "architect", left: 28, top: 4 },
  { id: "builder", left: 48, top: 4 },
  { id: "debugger", left: 68, top: 4 },
  { id: "reviewer", left: 88, top: 14 },
];

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

  // Per-agent latest state (for arc nodes)
  const agentState = useMemo(() => {
    const state: Record<string, { status: "idle" | "active" | "done" | "error"; item?: ActivityStreamItem }> = {};
    AGENT_IDS.forEach((id) => {
      state[id] = { status: "idle" };
    });
    delegationItems.forEach((item) => {
      const agent = (item.agent ?? "").toLowerCase();
      if (!AGENT_IDS.includes(agent as any)) return;
      const isActive = item.status === "running" || item.status === "active";
      const isDone = item.status === "done";
      const isError = item.status === "error";
      if (isActive) state[agent] = { status: "active", item };
      else if (isError) state[agent] = { status: "error", item };
      else if (isDone) state[agent] = { status: "done", item };
    });
    return state;
  }, [delegationItems]);

  const hasAny = delegationItems.length > 0;

  if (!hasAny) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-6 text-center">
        <p className="text-sm">Guided — Agent animation</p>
        <p className="text-xs mt-1">Delegation activity will appear here.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-border bg-muted/20">
        <span className="text-xs font-medium">Guided — Agent animation</span>
      </div>
      <div className="flex-1 overflow-auto p-3 min-h-[200px]">
        <div className="relative w-full aspect-[1.4] max-w-[320px] mx-auto">
          {/* Data flow lines: Main (50, 78) to each active agent */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none z-0" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
            {ARC_POSITIONS.map((pos) => {
              const state = agentState[pos.id] ?? { status: "idle" as const };
              const isActive = state.status === "active";
              if (!isActive) return null;
              return (
                <motion.line
                  key={pos.id}
                  x1="50"
                  y1="78"
                  x2={String(pos.left)}
                  y2={String(pos.top + 8)}
                  stroke="rgb(16 185 129 / 0.6)"
                  strokeWidth="1.5"
                  strokeDasharray="4 3"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.2 }}
                />
              );
            })}
          </svg>
          {/* Main (centre) */}
          <div
            className="absolute left-1/2 bottom-[22%] -translate-x-1/2 flex flex-col items-center gap-1 z-10"
          >
            <div className="w-10 h-10 rounded-lg border-2 border-emerald-500/50 bg-muted/30 flex items-center justify-center">
              <Bot className="h-5 w-5 text-muted-foreground" />
            </div>
            <span className="text-[10px] font-medium text-muted-foreground">Main</span>
          </div>

          {/* Agent nodes in arc */}
          {ARC_POSITIONS.map((pos) => {
            const agentId = pos.id;
            const state = agentState[agentId] ?? { status: "idle" as const };
            const Icon = getAgentIcon(agentId);
            const isActive = state.status === "active";
            const isDone = state.status === "done";
            const isError = state.status === "error";

            return (
              <React.Fragment key={agentId}>
                <div
                  className="absolute z-10 flex flex-col items-center gap-0.5"
                  style={{ left: `${pos.left}%`, top: `${pos.top}%`, transform: "translate(-50%, 0)" }}
                >
                  <motion.div
                    className={cn(
                      "w-9 h-9 rounded-lg border-2 flex items-center justify-center",
                      isActive && "border-emerald-500 animate-pulse bg-emerald-500/10",
                      isDone && "border-emerald-600 bg-emerald-500/5",
                      isError && "border-destructive/50 bg-destructive/5",
                      state.status === "idle" && "border-border bg-muted/20"
                    )}
                    initial={false}
                    animate={isActive ? { scale: [1, 1.05, 1] } : {}}
                    transition={{ repeat: isActive ? Infinity : 0, duration: 0.6 }}
                  >
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    {isActive && <Loader2 className="h-3 w-3 absolute bottom-0.5 right-0.5 animate-spin text-emerald-500" />}
                    {isDone && <Check className="h-3.5 w-3.5 absolute -top-0.5 -right-0.5 text-emerald-600" />}
                    {isError && <X className="h-3.5 w-3.5 absolute -top-0.5 -right-0.5 text-destructive" />}
                  </motion.div>
                  <span className="text-[10px] font-medium text-muted-foreground">
                    {getAgentLabel(agentId)}
                  </span>
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
