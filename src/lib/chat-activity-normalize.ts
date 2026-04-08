import type { ActivityStreamItem } from "@/atoms/sourceAtoms";

export const MAX_ACTIVITY_STREAM_ITEMS = 200;

const VALID_TYPES = new Set<string>([
  "model_selection",
  "delegation",
  "delegation_start",
  "delegation_complete",
  "delegation_error",
  "self_review",
  "background",
  "tool_use",
  "turn_summary",
  "mode_change",
  "agent_message",
  "routing_decision",
  "classifier_routing",
  "orchestrator_blocker",
]);

function normStatus(s: unknown): ActivityStreamItem["status"] {
  if (s === "running" || s === "done" || s === "error" || s === "active") return s;
  if (s === "complete") return "done";
  return "done";
}

/**
 * Coerce main-process chat:activity payloads into ActivityStreamItem, or null if unsupported.
 */
export function normalizeChatActivityPayload(raw: unknown): ActivityStreamItem | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  let typeRaw = p.type;
  if (typeof typeRaw !== "string") return null;
  let type = typeRaw === "tool" ? "tool_use" : typeRaw;
  if (!VALID_TYPES.has(type)) return null;
  const id = p.id != null ? String(p.id) : "";
  if (!id) return null;

  const item: ActivityStreamItem = {
    id,
    type: type as ActivityStreamItem["type"],
    label: String(p.label ?? type),
    status: normStatus(p.status),
    timestamp: typeof p.timestamp === "number" ? p.timestamp : Date.now(),
    tokens: typeof p.tokens === "number" ? p.tokens : undefined,
    cost: typeof p.cost === "number" ? p.cost : undefined,
    detail: p.detail != null ? String(p.detail) : undefined,
    parentId: p.parentId != null ? String(p.parentId) : undefined,
    agent: p.agent != null ? String(p.agent) : undefined,
    task: p.task != null ? String(p.task) : undefined,
    depth: typeof p.depth === "number" ? p.depth : undefined,
    result: p.result != null ? String(p.result) : undefined,
    duration: typeof p.duration === "number" ? p.duration : undefined,
    tools: Array.isArray(p.tools) ? (p.tools as string[]) : undefined,
    fromAgent: p.fromAgent != null ? String(p.fromAgent) : undefined,
    toAgent: p.toAgent != null ? String(p.toAgent) : undefined,
    threadId: p.threadId != null ? String(p.threadId) : undefined,
    chatId: typeof p.chatId === "number" ? p.chatId : undefined,
  };
  return item;
}
