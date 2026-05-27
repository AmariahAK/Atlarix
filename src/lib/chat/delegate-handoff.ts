import type { HandoffAgentRole } from "@/components/chat/HandoffResultCard";
import type { AssistantMessagePart } from "@/lib/chat/assistant-message-parts";

const HANDOFF_AGENT_ROLES: HandoffAgentRole[] = [
  "research",
  "explore",
  "scout",
  "architect",
  "builder",
  "reviewer",
  "debugger",
];

export type DelegateHandoffMeta = {
  agentRole: HandoffAgentRole;
  summary: string;
  structuredPayload?: unknown;
  validationStatus: "success" | "fallback";
  scope?: string;
};

export function isDelegateToolName(toolName: string): boolean {
  return toolName === "delegate_to_agent" || toolName === "spawn_sub_agent";
}

/** Hide per-tool delegate rows when the stream thread already shows a sub-agent round panel. */
export function filterDelegateToolParts(
  parts: AssistantMessagePart[],
  suppressDelegateTools: boolean,
): AssistantMessagePart[] {
  if (!suppressDelegateTools) return parts;
  return parts.filter(
    (p) => !(p.type === "tool" && isDelegateToolName(p.toolName)),
  );
}

export function parseDelegateHandoffFromToolResult(
  resultText: string | undefined,
): DelegateHandoffMeta | null {
  if (!resultText?.trim()) return null;
  try {
    const parsed = JSON.parse(resultText) as Record<string, unknown>;
    if (!parsed || parsed.success !== true) return null;
    const summary =
      typeof parsed.summary === "string"
        ? parsed.summary
        : String(parsed.summary ?? "");
    const roleRaw = parsed.agentRole;
    const agentRole = (
      typeof roleRaw === "string" &&
      (HANDOFF_AGENT_ROLES as readonly string[]).includes(roleRaw)
        ? roleRaw
        : "research"
    ) as HandoffAgentRole;
    const validation = parsed.validation as { status?: string } | undefined;
    return {
      agentRole,
      summary,
      structuredPayload:
        parsed.structuredPayload !== undefined
          ? parsed.structuredPayload
          : undefined,
      validationStatus:
        validation?.status === "fallback" ? "fallback" : "success",
      scope:
        typeof parsed.scope === "string" ? parsed.scope : undefined,
    };
  } catch {
    return null;
  }
}

/** Human-facing scope for sub-agent cards (never the preset name alone). */
export function delegateScopeFromArgs(args: {
  context?: string;
  default_focus_path?: string;
  preset?: string;
  scopes?: string[];
  task?: string;
}): string | undefined {
  const focus = args.default_focus_path?.trim();
  if (focus) return focus;

  const scopes = Array.isArray(args.scopes)
    ? args.scopes.map((s) => String(s).trim()).filter(Boolean)
    : [];
  if (scopes.length === 1) return scopes[0]!;
  if (scopes.length > 1) return `${scopes.length} repos`;

  const ctx = args.context?.trim();
  if (ctx && ctx.length <= 120) return ctx;

  const taskLine = args.task?.trim().split(/\r?\n/)[0]?.trim();
  if (taskLine && taskLine.length <= 80) return taskLine;

  return undefined;
}
