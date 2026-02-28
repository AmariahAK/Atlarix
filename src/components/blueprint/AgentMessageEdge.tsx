/**
 * Agent message edge: SVG particle along path using animateMotion (not stroke-dasharray).
 */

import React from "react";

const FLOW_COLORS: Record<string, string> = {
  request: "#f59e0b",
  response: "#22c55e",
  review: "#a855f7",
  fix: "#3b82f6",
};

interface AgentMessageEdgeProps {
  id: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  type?: "request" | "response" | "review" | "fix";
  active?: boolean;
}

export function AgentMessageEdge({
  id,
  from,
  to,
  type = "request",
  active = true,
}: AgentMessageEdgeProps) {
  const color = FLOW_COLORS[type] ?? FLOW_COLORS.request;
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const path = `M ${from.x} ${from.y} Q ${midX + 40} ${midY - 40} ${to.x} ${to.y}`;

  if (!active) return null;

  return (
    <g>
      <path
        d={path}
        fill="none"
        stroke="rgba(148,163,184,0.2)"
        strokeWidth="2"
      />
      <circle r="5" fill={color}>
        <animateMotion
          dur="0.6s"
          repeatCount="1"
          fill="freeze"
          calcMode="linear"
          path={path}
        />
      </circle>
    </g>
  );
}
