/**
 * Agent node for agent canvas: Framer Motion state-based styling (idle, thinking, delegating, etc.).
 */

import React from "react";
import { motion } from "framer-motion";
import { Bot, Layout, Wrench, Shield, Search } from "lucide-react";
import { useAgentAnimStore, type AgentId, type AgentAnimState } from "@/lib/agents/animation-state";
import { cn } from "@/lib/utils";

const AGENT_ICONS: Record<AgentId, React.ReactNode> = {
  main: <Bot size={20} />,
  architect: <Layout size={20} />,
  builder: <Wrench size={20} />,
  reviewer: <Shield size={20} />,
  researcher: <Search size={20} />,
};

const STATE_STYLES: Record<
  AgentAnimState,
  { border: string; glow: string; iconOpacity: string }
> = {
  idle: { border: "border-slate-600", glow: "", iconOpacity: "opacity-60" },
  thinking: {
    border: "border-blue-400",
    glow: "shadow-[0_0_12px_rgba(96,165,250,0.6)]",
    iconOpacity: "opacity-100",
  },
  delegating: {
    border: "border-amber-400",
    glow: "shadow-[0_0_12px_rgba(251,191,36,0.6)]",
    iconOpacity: "opacity-100",
  },
  reviewing: {
    border: "border-purple-400",
    glow: "shadow-[0_0_12px_rgba(192,132,252,0.6)]",
    iconOpacity: "opacity-100",
  },
  waiting: {
    border: "border-slate-400",
    glow: "",
    iconOpacity: "opacity-40",
  },
  error: {
    border: "border-red-400",
    glow: "shadow-[0_0_12px_rgba(248,113,113,0.6)]",
    iconOpacity: "opacity-100",
  },
  done: {
    border: "border-green-400",
    glow: "shadow-[0_0_12px_rgba(74,222,128,0.6)]",
    iconOpacity: "opacity-100",
  },
};

interface AgentNodeProps {
  agentId: AgentId;
  label?: string;
  className?: string;
}

export function AgentNode({ agentId, label, className }: AgentNodeProps) {
  const state = useAgentAnimStore((s) => s.agentStates[agentId] ?? "idle");
  const styles = STATE_STYLES[state];
  const isThinking = state === "thinking";
  const isDelegating = state === "delegating";

  return (
    <motion.div
      className={cn(
        "relative rounded-xl border-2 bg-background/95 p-3 min-w-[80px] flex flex-col items-center gap-1",
        styles.border,
        styles.glow,
        className
      )}
      animate={isThinking ? { boxShadow: ["0 0 12px rgba(96,165,250,0.4)", "0 0 20px rgba(96,165,250,0.8)", "0 0 12px rgba(96,165,250,0.4)"] } : {}}
      transition={{ duration: 0.8, repeat: isThinking ? Infinity : 0 }}
    >
      {isDelegating && (
        <motion.span
          className="absolute top-1 right-1 w-2 h-2 rounded-full bg-amber-400"
          animate={{ scale: [1, 1.4, 1] }}
          transition={{ duration: 0.4, repeat: Infinity }}
        />
      )}
      <span className={cn("shrink-0", styles.iconOpacity)}>
        {AGENT_ICONS[agentId]}
      </span>
      <span className="text-xs font-medium capitalize">{agentId}</span>
      {state !== "idle" && (
        <span className="text-[10px] text-muted-foreground capitalize">
          {state}
        </span>
      )}
    </motion.div>
  );
}
