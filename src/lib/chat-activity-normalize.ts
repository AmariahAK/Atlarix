import type { ActivityStreamItem } from "@/atoms/sourceAtoms";
import { getToolActivityLabel } from "@/lib/tool-activity-labels";

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
  "parallel_prefetch_start",
  "parallel_prefetch_complete",
  "counsel_start",
  "counsel_participant_complete",
  "counsel_synthesising",
  "counsel_complete",
  "build_verification_complete",
  "memory_saved",
  "plan_created",
  "duration_limit_reached",
  "loop_detected",
  "loop_repetition_aborted",
]);

function normStatus(s: unknown): ActivityStreamItem["status"] {
  if (s === "running" || s === "done" || s === "error" || s === "active") return s;
  if (s === "complete") return "done";
  return "done";
}

function counselRoleLabel(
  role: ActivityStreamItem["counselRole"] | undefined,
): string {
  if (role === "fast") return "Fast";
  if (role === "balanced") return "Balanced";
  if (role === "thinking") return "Thinking";
  if (role === "synthesis") return "Synthesis";
  return "Participant";
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

  // Internal / noisy types — never surface in the activity stream UI.
  if (type === "routing_decision" || type === "classifier_routing") return null;

  if (type === "agent_message") {
    const from = p.fromAgent != null ? String(p.fromAgent) : "";
    const busType =
      p.agentMessageType != null
        ? String(p.agentMessageType)
        : (() => {
            const lab = String(p.label ?? "");
            const m = /:\s*(\w+)\s*$/.exec(lab);
            return m ? m[1]! : "";
          })();
    if (from === "main" && busType === "task_assign") return null;
  }

  const base: ActivityStreamItem = {
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
    sessionId: p.sessionId != null ? String(p.sessionId) : undefined,
    participantCount: typeof p.participantCount === "number" ? p.participantCount : undefined,
    counselRole:
      p.counselRole === "fast" ||
      p.counselRole === "balanced" ||
      p.counselRole === "thinking" ||
      p.counselRole === "synthesis"
        ? p.counselRole
        : undefined,
    preview: p.preview != null ? String(p.preview) : undefined,
    stepCount: typeof p.stepCount === "number" ? p.stepCount : undefined,
    synthesisLength: typeof p.synthesisLength === "number" ? p.synthesisLength : undefined,
    agentMessageType:
      p.agentMessageType != null ? String(p.agentMessageType) : undefined,
    toolName: p.toolName != null ? String(p.toolName) : undefined,
    loopTarget: p.loopTarget != null ? String(p.loopTarget) : undefined,
    loopCount: typeof p.loopCount === "number" ? p.loopCount : undefined,
    counselTrigger: p.trigger != null ? String(p.trigger) : undefined,
  };

  switch (type) {
    case "counsel_start": {
      const n = typeof p.participantCount === "number" ? p.participantCount : 3;
      return {
        ...base,
        label: "Counsel session",
        detail: undefined,
        status: "running",
        participantCount: n,
      };
    }
    case "counsel_participant_complete": {
      const role =
        p.counselRole === "fast" ||
        p.counselRole === "balanced" ||
        p.counselRole === "thinking" ||
        p.counselRole === "synthesis"
          ? p.counselRole
          : undefined;
      const prev = p.preview != null ? String(p.preview).trim() : "";
      return {
        ...base,
        counselRole: role,
        label: counselRoleLabel(role),
        preview: prev || undefined,
        detail: undefined,
        status: "done",
      };
    }
    case "counsel_synthesising":
      return {
        ...base,
        label: "Synthesising perspectives",
        detail: undefined,
        status: "running",
        counselRole: "synthesis",
      };
    case "counsel_complete": {
      const synLen =
        typeof p.synthesisLength === "number"
          ? p.synthesisLength
          : undefined;
      const det = p.detail != null ? String(p.detail).trim() : "";
      return {
        ...base,
        label: "Counsel complete",
        detail: det || undefined,
        status: "done",
        synthesisLength: synLen,
      };
    }
    case "parallel_prefetch_start":
      return {
        ...base,
        label: "Research + planning (parallel)",
        detail:
          typeof p.detail === "string" && p.detail.trim()
            ? String(p.detail).trim()
            : "Running in background while the stream continues",
        status: "running",
      };
    case "parallel_prefetch_complete": {
      const agentRuns =
        typeof p.stepCount === "number" && p.stepCount > 0
          ? `${p.stepCount} specialist run${p.stepCount === 1 ? "" : "s"} finished`
          : typeof p.detail === "string" && p.detail.trim()
            ? String(p.detail).trim()
            : "Parallel prefetch finished";
      return {
        ...base,
        label: "Research + planning complete",
        detail: agentRuns,
        status: "done",
        stepCount: typeof p.stepCount === "number" ? p.stepCount : undefined,
      };
    }
    case "duration_limit_reached":
      return {
        ...base,
        label: "Task paused after 30 minutes",
        detail:
          p.detail != null && String(p.detail).trim()
            ? String(p.detail).trim()
            : "Send a message to continue",
        status: "done",
      };
    case "loop_detected": {
      const tn = p.toolName != null ? String(p.toolName) : "tool";
      const tgt = p.loopTarget != null ? String(p.loopTarget).trim() : "";
      const cnt = typeof p.loopCount === "number" ? p.loopCount : 3;
      return {
        ...base,
        label: "Repeated action detected",
        detail: tgt
          ? `${tn} on same target (${cnt}+ in short window) — self-correcting: ${tgt.slice(0, 120)}`
          : `${tn} repeated (${cnt}+ in short window) — self-correcting`,
        status: "running",
        toolName: tn,
        loopTarget: tgt || undefined,
        loopCount: cnt,
      };
    }
    case "loop_repetition_aborted":
      return {
        ...base,
        label: "Task stopped — repeated action",
        detail:
          p.detail != null && String(p.detail).trim()
            ? String(p.detail).trim()
            : "Review the activity log and send a message to continue.",
        status: "done",
      };
    case "tool_use": {
      const tn = p.toolName != null ? String(p.toolName) : "";
      const rawLab = String(p.label ?? "");
      const resolvedTool =
        tn || (/^[a-z][a-z0-9_]*$/i.test(rawLab) ? rawLab : "");
      const human = resolvedTool ? getToolActivityLabel(resolvedTool) : rawLab || "Tool";
      const label = human.length > 60 ? `${human.slice(0, 57)}…` : human;
      return {
        ...base,
        label,
        toolName: tn || undefined,
      };
    }
    default:
      break;
  }

  return base;
}
