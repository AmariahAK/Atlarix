import type { ActivityStreamItem } from "@/atoms/sourceAtoms";
import { delegateScopeFromArgs } from "@/lib/chat/delegate-handoff";

export const SUBAGENT_ACTIVITY_TYPES = new Set([
  "subagent_start",
  "subagent_progress",
  "subagent_complete",
]);

export function subagentLabel(agentId: string): string {
  const short =
    agentId.length > 28 ? `${agentId.slice(0, 25)}…` : agentId;
  const titled = short.replace(/^./, (c) => c.toUpperCase());
  const label = `Sub-agent: ${titled}`;
  return label.length > 60 ? `${label.slice(0, 57)}…` : label;
}

export function buildSubagentStartPayload(args: {
  id: string;
  chatId: number;
  agentId: string;
  task: string;
  scope?: string;
  parentToolId?: string;
  roundId?: string;
  timestamp?: number;
}): Record<string, unknown> {
  const ts = args.timestamp ?? Date.now();
  const displayScope = args.scope?.trim();
  const label = displayScope
    ? `${args.agentId} · ${displayScope}`
    : subagentLabel(args.agentId);
  return {
    type: "subagent_start",
    id: args.id,
    chatId: args.chatId,
    agent: args.agentId,
    agentType: args.agentId,
    task: args.task,
    scope: args.scope,
    parentToolId: args.parentToolId,
    parentDelegationId: args.id,
    roundId: args.roundId,
    status: "running",
    timestamp: ts,
    label,
  };
}

export function buildSubagentCompletePayload(args: {
  id: string;
  chatId: number;
  agentId: string;
  summary?: string;
  duration?: number;
  isError?: boolean;
  scope?: string;
  roundId?: string;
}): Record<string, unknown> {
  const displayScope = args.scope?.trim();
  const label = displayScope
    ? `${args.agentId} · ${displayScope}`
    : subagentLabel(args.agentId);
  return {
    type: "subagent_complete",
    id: args.id,
    chatId: args.chatId,
    agent: args.agentId,
    agentType: args.agentId,
    scope: args.scope,
    parentDelegationId: args.id,
    roundId: args.roundId,
    status: args.isError ? "error" : "done",
    result: args.summary,
    preview: args.summary?.slice(0, 200),
    duration: args.duration,
    timestamp: Date.now(),
    label,
  };
}

export function scopeFromDelegateArgs(args: Record<string, unknown>): string | undefined {
  return delegateScopeFromArgs({
    context: typeof args.context === "string" ? args.context : undefined,
    default_focus_path:
      typeof args.default_focus_path === "string"
        ? args.default_focus_path
        : undefined,
    preset: typeof args.preset === "string" ? args.preset : undefined,
  });
}

export function isSubagentActivityType(
  type: ActivityStreamItem["type"],
): boolean {
  return SUBAGENT_ACTIVITY_TYPES.has(type);
}
