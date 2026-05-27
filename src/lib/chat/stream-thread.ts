import type { ActivityStreamItem } from "@/atoms/sourceAtoms";
import { flattenToolGroupsInThread } from "@/lib/chat/group-stream-tools";
import {
  isDelegateToolName,
  type DelegateHandoffMeta,
} from "@/lib/chat/delegate-handoff";
import type { AssistantMessagePart } from "@/lib/chat/assistant-message-parts";
import { summarizeToolActivityItem } from "@/lib/chat/inline-timeline";
import {
  getToolCompletedSummary,
  getToolRunningSummary,
  looksLikeToolArgsJson,
} from "@/lib/chat/stream-tool-display";
import {
  buildToolExpandView,
  type ToolExpandView,
} from "@/lib/chat/tool-expand-view";

export type StreamThreadToolStatus = "running" | "done" | "error";

export function hasSubagentRoundPanel(items: StreamThreadItem[]): boolean {
  return items.some((i) => i.kind === "subagent_round");
}

export type SubAgentRunEntry = {
  id: string;
  agentType: string;
  label: string;
  scope?: string;
  summary?: string;
  status: StreamThreadToolStatus;
  nestedItems: StreamThreadItem[];
};

export type StreamThreadItem =
  | { kind: "thought"; id: string; content: string; ts: number }
  | {
      kind: "tool";
      id: string;
      /** Registry tool name (e.g. read_file) — used for matching tool:end. */
      toolName: string;
      summary: string;
      /** @deprecated raw tool output; use expand */
      detail?: string;
      expand?: ToolExpandView;
      status: StreamThreadToolStatus;
      ts: number;
    }
  | { kind: "plan"; planId: string; ts: number }
  | {
      kind: "background";
      id: string;
      label: string;
      status: "running" | "done" | "error";
      ts: number;
    }
  | {
      kind: "counsel";
      id: string;
      label: string;
      detail?: string;
      status: StreamThreadToolStatus;
      ts: number;
    }
  | {
      kind: "subagent_round";
      id: string;
      agents: SubAgentRunEntry[];
      status: StreamThreadToolStatus;
      ts: number;
    }
  | {
      kind: "subagent";
      id: string;
      agentType: string;
      label: string;
      scope?: string;
      summary?: string;
      status: StreamThreadToolStatus;
      ts: number;
      nestedItems?: StreamThreadItem[];
    }
  | {
      kind: "tool_group";
      id: string;
      category: string;
      tools: Extract<StreamThreadItem, { kind: "tool" }>[];
      summary: string;
      status: StreamThreadToolStatus;
      ts: number;
    };

const SUBAGENT_TYPES = new Set([
  "subagent_start",
  "subagent_progress",
  "subagent_complete",
]);

const COUNSEL_TYPES = new Set([
  "counsel_start",
  "counsel_participant_complete",
  "counsel_synthesising",
  "counsel_complete",
  "counsel_thinking",
  "counsel_timeout",
]);

function threadItemKey(item: StreamThreadItem): string {
  if (item.kind === "plan") return `plan:${item.planId}`;
  return `${item.kind}:${item.id}`;
}

/** Normalize IPC tool id / registry name for thread matching. */
export function resolveRegistryToolName(
  toolId?: string,
  fallback?: string,
): string {
  const id = toolId?.trim();
  if (id && !id.includes(" ")) return id;
  const fb = fallback?.trim();
  if (fb && !fb.includes(" ") && fb.includes("_")) return fb;
  return id ?? fb ?? "tool";
}

function isRunningTool(
  item: StreamThreadItem,
): item is Extract<StreamThreadItem, { kind: "tool" }> {
  return item.kind === "tool" && item.status === "running";
}

function toolStatusRank(status: StreamThreadToolStatus): number {
  if (status === "running") return 0;
  if (status === "done") return 1;
  return 2;
}

function mergeToolItems(
  prev: Extract<StreamThreadItem, { kind: "tool" }>,
  next: Extract<StreamThreadItem, { kind: "tool" }>,
): StreamThreadItem {
  if (toolStatusRank(prev.status) > toolStatusRank(next.status)) {
    return prev;
  }
  if (toolStatusRank(next.status) > toolStatusRank(prev.status)) {
    return {
      ...next,
      id: prev.id,
      toolName: prev.toolName || next.toolName,
      detail: next.detail ?? (next.status !== "running" ? prev.detail : undefined),
      expand: next.expand ?? prev.expand,
      summary:
        next.status === "running"
          ? getToolRunningSummary(prev.toolName)
          : next.summary || getToolCompletedSummary(prev.toolName),
    };
  }
  return {
    ...prev,
    ...next,
    id: prev.id,
    toolName: prev.toolName,
    detail: next.detail ?? prev.detail,
    expand: next.expand ?? prev.expand,
  };
}

export function upsertStreamThreadItem(
  items: StreamThreadItem[],
  item: StreamThreadItem,
): StreamThreadItem[] {
  const key = threadItemKey(item);
  const idx = items.findIndex((i) => threadItemKey(i) === key);
  if (idx >= 0) {
    const prev = items[idx]!;
    if (prev.kind === "tool" && item.kind === "tool") {
      const next = [...items];
      next[idx] = mergeToolItems(prev, item);
      return next;
    }
    const next = [...items];
    next[idx] = item;
    return next;
  }

  if (item.kind === "tool") {
    const altIdx = findRunningToolIndex(items, [item.toolName, item.id]);
    if (altIdx >= 0) {
      const prev = items[altIdx] as Extract<StreamThreadItem, { kind: "tool" }>;
      const next = [...items];
      next[altIdx] = mergeToolItems(prev, item);
      return next;
    }
  }

  return [...items, item];
}

export function streamThreadItemFromToolStart(payload: {
  toolId?: string;
  toolName?: string;
  chatId?: number;
}): StreamThreadItem {
  const registryName = resolveRegistryToolName(payload.toolId, payload.toolName);
  return {
    kind: "tool",
    id: registryName,
    toolName: registryName,
    summary: getToolRunningSummary(registryName),
    status: "running",
    ts: Date.now(),
  };
}

function finalizeToolItem(
  item: Extract<StreamThreadItem, { kind: "tool" }>,
  status: StreamThreadToolStatus,
  opts?: { summary?: string; detail?: string; expand?: ToolExpandView },
): StreamThreadItem {
  const registryName = item.toolName;
  const rawDetail = opts?.detail ?? item.detail;
  const expand =
    opts?.expand ??
    (rawDetail
      ? buildToolExpandView(registryName, undefined, rawDetail, status)
      : item.expand);
  return {
    ...item,
    status,
    summary:
      opts?.summary ??
      (status === "running"
        ? getToolRunningSummary(registryName)
        : getToolCompletedSummary(registryName)),
    detail: rawDetail,
    expand,
  };
}

function findRunningToolIndex(
  items: StreamThreadItem[],
  keys: (string | undefined)[],
): number {
  const normalized = keys
    .map((k) => k?.trim())
    .filter((k): k is string => Boolean(k));
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!isRunningTool(item)) continue;
    for (const key of normalized) {
      if (
        item.id === key ||
        item.toolName === key ||
        item.id.startsWith(`tool-${key}-`) ||
        item.id.startsWith(`${key}_`)
      ) {
        return i;
      }
    }
  }
  return -1;
}

export type StreamToolEndPayload = {
  toolId?: string;
  toolName?: string;
  status?: StreamThreadToolStatus;
  /** Raw result or activity detail — formatted for expand preview. */
  detail?: string;
};

/**
 * Apply tool:end (or activity done) to the live thread — match by registry tool id.
 */
export function handleStreamToolEnd(
  items: StreamThreadItem[],
  payload: StreamToolEndPayload,
): StreamThreadItem[] {
  const registryName = resolveRegistryToolName(payload.toolId, payload.toolName);
  const status = payload.status ?? "done";

  return completeStreamToolOnEnd(items, {
    toolId: registryName,
    toolName: registryName,
    status,
    detail: payload.detail,
    summary: getToolCompletedSummary(registryName),
  });
}

/**
 * Complete a running tool card — match by toolId first, then registry toolName, then last running.
 */
export function completeStreamToolOnEnd(
  items: StreamThreadItem[],
  opts?: StreamToolEndPayload & { summary?: string },
): StreamThreadItem[] {
  const status = opts?.status ?? "done";
  const keys = [
    opts?.toolId,
    opts?.toolName,
    resolveRegistryToolName(opts?.toolId, opts?.toolName),
  ];

  const idx = findRunningToolIndex(items, keys);
  if (idx >= 0) {
    const next = [...items];
    next[idx] = finalizeToolItem(
      items[idx] as Extract<StreamThreadItem, { kind: "tool" }>,
      status,
      { summary: opts?.summary, detail: opts?.detail },
    );
    return next;
  }

  return completeLastRunningStreamTool(items, status, opts);
}

/** Mark the most recent running tool card done (fallback when tool:end has no id). */
export function completeLastRunningStreamTool(
  items: StreamThreadItem[],
  status: StreamThreadToolStatus = "done",
  opts?: { summary?: string; detail?: string },
): StreamThreadItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (isRunningTool(item)) {
      const next = [...items];
      next[i] = finalizeToolItem(item, status, opts);
      return next;
    }
  }
  return items;
}

/** Force any still-running tool cards to done (e.g. at stream end). */
export function finalizeAllRunningStreamTools(
  items: StreamThreadItem[],
  status: StreamThreadToolStatus = "done",
): StreamThreadItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (isRunningTool(item)) {
      changed = true;
      return finalizeToolItem(item, status);
    }
    return item;
  });
  return changed ? next : items;
}

function isRunningBackgroundOrCounsel(
  item: StreamThreadItem,
): item is Extract<StreamThreadItem, { kind: "background" | "counsel" }> {
  return (
    (item.kind === "background" || item.kind === "counsel") &&
    item.status === "running"
  );
}

/** Mark running background/counsel cards done when the stream ends. */
export function finalizeRunningBackgroundItems(
  items: StreamThreadItem[],
): StreamThreadItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (isRunningBackgroundOrCounsel(item)) {
      changed = true;
      return { ...item, status: "done" as const };
    }
    return item;
  });
  return changed ? next : items;
}

export function streamThreadItemFromToolEnd(payload: {
  toolId?: string;
  toolName: string;
  status?: "success" | "error";
}): StreamThreadItem {
  const registryName = resolveRegistryToolName(payload.toolId, payload.toolName);
  return {
    kind: "tool",
    id: registryName,
    toolName: registryName,
    summary: getToolCompletedSummary(registryName),
    status: payload.status === "error" ? "error" : "done",
    ts: Date.now(),
  };
}

export function streamThreadItemFromActivity(
  item: ActivityStreamItem,
): StreamThreadItem | null {
  const ts = item.timestamp ?? Date.now();
  const id = item.id || `act-${ts}`;

  if (item.type === "tool_use" || item.type === "tool") {
    const registryName = (item.toolName ?? "").trim() || "tool";
    const stableId = registryName;
    const isRunning =
      item.status === "running" || item.status === "active";
    const status: StreamThreadToolStatus = isRunning
      ? "running"
      : item.status === "error"
        ? "error"
        : "done";

    let rawDetail = item.detail?.trim();
    if (isRunning && looksLikeToolArgsJson(rawDetail)) {
      rawDetail = undefined;
    }

    const expand =
      !isRunning && rawDetail
        ? buildToolExpandView(registryName, undefined, rawDetail, status)
        : undefined;

    return {
      kind: "tool",
      id: stableId,
      toolName: registryName,
      summary: isRunning
        ? getToolRunningSummary(registryName)
        : summarizeToolActivityItem(item) ||
          getToolCompletedSummary(registryName),
      detail: rawDetail,
      expand,
      status,
      ts,
    };
  }

  if (COUNSEL_TYPES.has(item.type) || SUBAGENT_TYPES.has(item.type)) {
    return null;
  }

  if (item.type === "background") {
    return {
      kind: "background",
      id,
      label: item.label ?? "Background task",
      status:
        item.status === "running" || item.status === "active"
          ? "running"
          : item.status === "error"
            ? "error"
            : "done",
      ts,
    };
  }

  if (item.type === "plan_created" && item.detail) {
    const planId = item.detail.trim();
    if (/^[0-9a-f-]{36}$/i.test(planId)) {
      return { kind: "plan", planId, ts };
    }
  }

  return null;
}

function counselParticipantRoleLabel(item: ActivityStreamItem): string {
  if (item.counselRole === "fast") return "Fast";
  if (item.counselRole === "balanced") return "Balanced";
  if (item.counselRole === "thinking") return "Thinking";
  if (item.counselRole === "synthesis") return "Synthesis";
  return item.label?.trim() || "Participant";
}

/** Merge counsel activity events into one collapsible thread card per chat. */
export function mergeCounselActivityIntoThread(
  items: StreamThreadItem[],
  chatId: number,
  item: ActivityStreamItem,
): StreamThreadItem[] {
  if (!COUNSEL_TYPES.has(item.type)) return items;

  const counselId = `counsel-${chatId}`;
  const ts = item.timestamp ?? Date.now();
  const idx = items.findIndex((i) => i.kind === "counsel" && i.id === counselId);

  const upsertCounsel = (
    next: Extract<StreamThreadItem, { kind: "counsel" }>,
  ): StreamThreadItem[] => {
    if (idx >= 0) {
      const copy = [...items];
      copy[idx] = next;
      return copy;
    }
    return [...items, next];
  };

  if (item.type === "counsel_thinking") {
    return items;
  }

  if (item.type === "counsel_start") {
    return upsertCounsel({
      kind: "counsel",
      id: counselId,
      label: "Consulting multiple models…",
      detail: "",
      status: "running",
      ts,
    });
  }

  const prev: Extract<StreamThreadItem, { kind: "counsel" }> =
    idx >= 0
      ? (items[idx] as Extract<StreamThreadItem, { kind: "counsel" }>)
      : {
          kind: "counsel",
          id: counselId,
          label: "Consulting multiple models…",
          detail: "",
          status: "running",
          ts,
        };

  if (item.type === "counsel_participant_complete") {
    const role = counselParticipantRoleLabel(item);
    const preview = item.preview?.trim() ?? item.detail?.trim() ?? "";
    const section = preview ? `\n\n**[${role}]:** ${preview}` : "";
    const detail = `${prev.detail ?? ""}${section}`.trim();
    return upsertCounsel({
      ...prev,
      detail,
      status: "running",
      ts,
    });
  }

  if (item.type === "counsel_synthesising") {
    return upsertCounsel({
      ...prev,
      label: "Synthesising perspectives",
      status: "running",
      ts,
    });
  }

  if (item.type === "counsel_complete" || item.type === "counsel_timeout") {
    const snippet =
      item.detail?.trim() ||
      (item.type === "counsel_timeout"
        ? "Maximum wait time reached; partial results may be incomplete."
        : typeof item.synthesisLength === "number"
          ? `Synthesis: ${item.synthesisLength} characters`
          : "");
    const detail = [prev.detail, snippet].filter(Boolean).join("\n\n").trim();
    return upsertCounsel({
      ...prev,
      label:
        item.type === "counsel_timeout" ? "Counsel timed out" : "Counsel complete",
      detail,
      status: "done",
      ts,
    });
  }

  return items;
}

function roundStatus(agents: SubAgentRunEntry[]): StreamThreadToolStatus {
  if (agents.some((a) => a.status === "running")) return "running";
  if (agents.some((a) => a.status === "error")) return "error";
  return "done";
}

function upsertSubagentRound(
  items: StreamThreadItem[],
  roundId: string,
  updater: (agents: SubAgentRunEntry[]) => SubAgentRunEntry[],
): StreamThreadItem[] {
  const withoutLegacy = items.filter((i) => i.kind !== "subagent");
  const roundIdx = withoutLegacy.findIndex(
    (i) => i.kind === "subagent_round" && i.id === roundId,
  );
  const ts = Date.now();
  const prevRound =
    roundIdx >= 0 && withoutLegacy[roundIdx]?.kind === "subagent_round"
      ? withoutLegacy[roundIdx]
      : null;
  const agents = updater(prevRound?.agents ?? []);
  const nextRound: Extract<StreamThreadItem, { kind: "subagent_round" }> = {
    kind: "subagent_round",
    id: roundId,
    agents,
    status: roundStatus(agents),
    ts: prevRound?.ts ?? ts,
  };
  if (roundIdx >= 0) {
    const copy = [...withoutLegacy];
    copy[roundIdx] = nextRound;
    return copy;
  }
  return [...withoutLegacy, nextRound];
}

/** Merge subagent IPC events into a single round panel with per-agent cards. */
export function mergeSubagentActivityIntoThread(
  items: StreamThreadItem[],
  item: ActivityStreamItem,
): StreamThreadItem[] {
  if (!SUBAGENT_TYPES.has(item.type)) return items;

  const roundId =
    (item as ActivityStreamItem & { roundId?: string }).roundId ??
    "subagent-round";
  const subId = item.id || `subagent-${item.timestamp ?? Date.now()}`;
  const agentType = String(item.agentType ?? item.agent ?? "agent");
  const ts = item.timestamp ?? Date.now();

  const upsertAgent = (
    next: SubAgentRunEntry,
  ): StreamThreadItem[] =>
    upsertSubagentRound(items, roundId, (agents) => {
      const idx = agents.findIndex((a) => a.id === subId);
      if (idx >= 0) {
        const copy = [...agents];
        copy[idx] = { ...agents[idx]!, ...next, id: subId };
        return copy;
      }
      return [...agents, next];
    });

  const existingRound = items.find(
    (i): i is Extract<StreamThreadItem, { kind: "subagent_round" }> =>
      i.kind === "subagent_round" && i.id === roundId,
  );
  const existingAgent = existingRound?.agents.find((a) => a.id === subId);

  if (item.type === "subagent_start") {
    return upsertAgent({
      id: subId,
      agentType,
      label: item.label ?? `${agentType}`,
      scope: item.scope,
      status: "running",
      nestedItems: existingAgent?.nestedItems ?? [],
    });
  }

  if (item.type === "subagent_progress") {
    const snippet = item.preview?.trim() || item.detail?.trim();
    return upsertAgent({
      id: subId,
      agentType,
      label: existingAgent?.label ?? item.label ?? agentType,
      scope: item.scope ?? existingAgent?.scope,
      summary: snippet ?? existingAgent?.summary,
      status: "running",
      nestedItems: existingAgent?.nestedItems ?? [],
    });
  }

  if (item.type === "subagent_complete") {
    const summary =
      item.result?.trim() ||
      item.preview?.trim() ||
      item.detail?.trim() ||
      existingAgent?.summary;
    return upsertAgent({
      id: subId,
      agentType,
      label: existingAgent?.label ?? item.label ?? agentType,
      scope: item.scope ?? existingAgent?.scope,
      summary,
      status: item.status === "error" ? "error" : "done",
      nestedItems: existingAgent?.nestedItems ?? [],
    });
  }

  return items;
}

/** Nest a tool/thought activity under a sub-agent card inside the active round. */
export function mergeNestedActivityIntoSubagentRound(
  items: StreamThreadItem[],
  parentDelegationId: string,
  nested: StreamThreadItem,
): StreamThreadItem[] {
  return items.map((item) => {
    if (item.kind !== "subagent_round") return item;
    const agents = item.agents.map((agent) => {
      if (agent.id !== parentDelegationId) return agent;
      return {
        ...agent,
        nestedItems: upsertStreamThreadItem(agent.nestedItems, nested),
      };
    });
    return { ...item, agents };
  });
}

/** Pin live stream-thread cards to an assistant message before clearing the chat map. */
export function freezeStreamThreadForAssistantMessage(
  items: StreamThreadItem[],
  thoughtContent?: string | null,
): StreamThreadItem[] {
  let finalized = finalizeAllRunningStreamTools(items);
  finalized = finalizeRunningBackgroundItems(finalized);
  finalized = flattenToolGroupsInThread(finalized);
  const thought = thoughtContent?.trim();
  if (thought && !finalized.some((i) => i.kind === "thought")) {
    finalized = [
      { kind: "thought", id: "turn-thought", content: thought, ts: 0 },
      ...finalized,
    ];
  }
  return finalized;
}

/** Apply pending subagent IPC rows before freezing the live thread. */
export function mergePendingSubagentActivitiesIntoThread(
  items: StreamThreadItem[],
  activities: ActivityStreamItem[],
  chatId: number,
): StreamThreadItem[] {
  let next = items;
  for (const item of activities) {
    if (item.chatId != null && item.chatId !== chatId) continue;
    if (
      item.type === "subagent_start" ||
      item.type === "subagent_progress" ||
      item.type === "subagent_complete"
    ) {
      next = mergeSubagentActivityIntoThread(next, item);
    }
  }
  return next;
}

/** Build a round panel from persisted delegate handoffs when IPC freeze missed the round. */
export function synthesizeSubagentRoundFromParts(
  parts: AssistantMessagePart[],
  roundId = "subagent-round-fallback",
): Extract<StreamThreadItem, { kind: "subagent_round" }> | null {
  const delegates = parts.filter(
    (
      p,
    ): p is Extract<AssistantMessagePart, { type: "tool" }> & {
      handoff: DelegateHandoffMeta;
    } =>
      p.type === "tool" &&
      isDelegateToolName(p.toolName) &&
      Boolean(p.handoff?.summary?.trim()),
  );
  if (!delegates.length) return null;

  const agents: SubAgentRunEntry[] = delegates.map((p, index) => ({
    id: `handoff-${p.id}-${index}`,
    agentType: p.handoff.agentRole,
    label: p.handoff.scope
      ? `${p.handoff.agentRole} · ${p.handoff.scope}`
      : p.handoff.agentRole,
    scope: p.handoff.scope,
    summary: p.handoff.summary,
    status:
      p.status === "error"
        ? "error"
        : p.status === "running"
          ? "running"
          : "done",
    nestedItems: [],
  }));

  const status: StreamThreadToolStatus = agents.some((a) => a.status === "running")
    ? "running"
    : agents.some((a) => a.status === "error")
      ? "error"
      : "done";

  return {
    kind: "subagent_round",
    id: roundId,
    agents,
    status,
    ts: Date.now(),
  };
}

export function normalizeProseKey(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function proseAlreadyRendered(
  prose: string,
  parts: { type: string; content?: string }[],
): boolean {
  if (!prose.trim()) return true;
  const key = normalizeProseKey(prose);
  if (!key) return true;
  return parts.some((p) => {
    if (typeof p.content !== "string") return false;
    const pk = normalizeProseKey(p.content);
    if (!pk) return false;
    if (p.type === "markdown" && pk.includes(key)) return true;
    if (
      p.type === "thought" &&
      pk.length > 24 &&
      (pk.includes(key) || key.includes(pk))
    ) {
      return true;
    }
    return false;
  });
}
