/**
 * Autonomous mode: Agent animation — centre Main, arc of agents, tree of sub-agents.
 * Data flow to/from agents; when done, data back to creator and node marked done.
 * Pillars/icons with agent names only (no model names).
 */

import React, { useMemo } from "react";
import { useAtomValue } from "jotai";
import { activityStreamItemsAtom, type ActivityStreamItem } from "@/atoms/sourceAtoms";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { Search, Box, Hammer, Eye, Loader2, Check, X, Bot } from "lucide-react";

const AGENT_IDS = ["research", "architect", "builder", "reviewer"] as const;
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

function getAgentLabel(agentId: string): string {
  return (agentId ?? "agent").replace(/^./, (c) => c.toUpperCase());
}

const ARC_POSITIONS = [
  { id: "research", left: 12, top: 12 },
  { id: "architect", left: 38, top: 4 },
  { id: "builder", left: 62, top: 4 },
  { id: "reviewer", left: 88, top: 12 },
];

function buildTree(items: ActivityStreamItem[]): { root: ActivityStreamItem[]; childrenByParent: Map<string, ActivityStreamItem[]> } {
  const byId = new Map<string, ActivityStreamItem>();
  items.forEach((i) => byId.set(i.id, i));
  const root: ActivityStreamItem[] = [];
  const childrenByParent = new Map<string, ActivityStreamItem[]>();
  items.forEach((item) => {
    if (item.parentId == null || !byId.has(item.parentId)) {
      root.push(item);
    } else {
      const list = childrenByParent.get(item.parentId) ?? [];
      list.push(item);
      childrenByParent.set(item.parentId, list);
    }
  });
  root.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  childrenByParent.forEach((list) => list.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)));
  return { root, childrenByParent };
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
  delegationRaw.forEach((i) => byId.set(i.id, i));
  const delegationItems = Array.from(byId.values()).sort(
    (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)
  );

  const { root, childrenByParent } = useMemo(
    () => buildTree(delegationItems),
    [delegationItems]
  );

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
        <p className="text-sm">Autonomous — Agent animation</p>
        <p className="text-xs mt-1">Delegation activity will appear here.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-border bg-muted/20">
        <span className="text-xs font-medium">Autonomous — Agent animation</span>
      </div>
      <div className="flex-1 overflow-auto p-3 min-h-[200px]">
        <div className="relative w-full aspect-[1.4] max-w-[320px] mx-auto">
          <svg className="absolute inset-0 w-full h-full pointer-events-none z-0" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
            {ARC_POSITIONS.map((pos) => {
              const state = agentState[pos.id] ?? { status: "idle" as const };
              if (state.status !== "active") return null;
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
                  transition={{ duration: 0.4 }}
                />
              );
            })}
          </svg>

          <div className="absolute left-1/2 bottom-[22%] -translate-x-1/2 flex flex-col items-center gap-1 z-10">
            <div className="w-10 h-10 rounded-lg border-2 border-emerald-500/50 bg-muted/30 flex items-center justify-center">
              <Bot className="h-5 w-5 text-muted-foreground" />
            </div>
            <span className="text-[10px] font-medium text-muted-foreground">Main</span>
          </div>

          {ARC_POSITIONS.map((pos) => {
            const agentId = pos.id;
            const state = agentState[agentId] ?? { status: "idle" };
            const Icon = getAgentIcon(agentId);
            const isActive = state.status === "active";
            const isDone = state.status === "done";
            const isError = state.status === "error";

            return (
              <div
                key={agentId}
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
                  animate={isActive ? { scale: [1, 1.05, 1] } : {}}
                  transition={{ repeat: isActive ? Infinity : 0, duration: 1.2 }}
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
            );
          })}
        </div>

        {/* Sub-agents tree (under root delegations that have children) */}
        {root.some((r) => (childrenByParent.get(r.id)?.length ?? 0) > 0) && (
          <div className="mt-4 pt-3 border-t border-border space-y-2">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Sub-agents</p>
            {root.map((item) => {
              const children = childrenByParent.get(item.id) ?? [];
              if (children.length === 0) return null;
              const agentName = getAgentLabel(item.agent ?? "agent");
              return (
                <div key={item.id} className="pl-3 border-l-2 border-emerald-500/30 space-y-1.5">
                  <div className="text-[10px] text-muted-foreground">{agentName}</div>
                  {children.map((child) => {
                    const Icon = getAgentIcon(child.agent ?? "agent");
                    const isActive = child.status === "running" || child.status === "active";
                    const isDone = child.status === "done";
                    const isError = child.status === "error";
                    return (
                      <div
                        key={child.id}
                        className={cn(
                          "flex items-center gap-2 rounded border px-2 py-1.5 text-xs",
                          isActive && "border-emerald-500/50 bg-emerald-500/5",
                          isDone && "border-emerald-600/30 bg-emerald-500/5",
                          isError && "border-destructive/30 bg-destructive/5"
                        )}
                      >
                        <Icon className="h-3 w-3 text-muted-foreground shrink-0" />
                        <span className="truncate flex-1">{getAgentLabel(child.agent ?? "agent")}</span>
                        {isActive && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-emerald-500" />}
                        {isDone && <Check className="h-3 w-3 shrink-0 text-emerald-600" />}
                        {isError && <X className="h-3 w-3 shrink-0 text-destructive" />}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
