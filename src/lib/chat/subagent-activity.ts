import { delegateScopeFromArgs } from "@/lib/chat/delegate-handoff";

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
    scopes: Array.isArray(args.scopes) ? (args.scopes as string[]) : undefined,
    task: typeof args.task === "string" ? args.task : undefined,
  });
}

export function initialSubagentProgressPreview(
  scope: string | undefined,
  task: string,
): string {
  const scoped = scope?.trim();
  if (scoped) return `Mapping: ${scoped}`;
  const line = task.trim().split(/\r?\n/)[0]?.trim();
  if (line) return line.length > 100 ? `${line.slice(0, 97)}…` : line;
  return "Starting…";
}
