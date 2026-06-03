import type { ActivityStreamItem } from "@/atoms/sourceAtoms";
import { flattenToolGroupsInThread } from "@/lib/chat/group-stream-tools";
import {
  delegateDisplayMetaFromToolPart,
  isDelegateToolName,
  type DelegateHandoffMeta,
} from "@/lib/chat/delegate-handoff";
import {
  parseAssistantMessageParts,
  type AssistantMessagePart,
} from "@/lib/chat/assistant-message-parts";
import { summarizeToolActivityItem } from "@/lib/chat/inline-timeline";
import {
  formatToolResultPreview,
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
      toolArgs?: Record<string, unknown>;
      resultText?: string;
      status: StreamThreadToolStatus;
      ts: number;
    }
  | { kind: "plan"; planId: string; ts: number }
  | {
      kind: "background";
      id: string;
      label: string;
      detail?: string;
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
      toolArgs: next.toolArgs ?? prev.toolArgs,
      resultText: next.resultText ?? prev.resultText,
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
    toolArgs: next.toolArgs ?? prev.toolArgs,
    resultText: next.resultText ?? prev.resultText,
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

/** Upsert nested sub-agent tools by id only (no toolName running-slot merge). */
export function upsertNestedStreamThreadItem(
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
  return [...items, item];
}

export function streamThreadItemFromToolStart(payload: {
  toolId?: string;
  toolName?: string;
  chatId?: number;
  toolArgs?: Record<string, unknown>;
}): StreamThreadItem {
  const registryName = resolveRegistryToolName(payload.toolId, payload.toolName);
  return {
    kind: "tool",
    id: registryName,
    toolName: registryName,
    summary: getToolRunningSummary(registryName),
    status: "running",
    toolArgs: payload.toolArgs,
    ts: Date.now(),
  };
}

function finalizeToolItem(
  item: Extract<StreamThreadItem, { kind: "tool" }>,
  status: StreamThreadToolStatus,
  opts?: {
    summary?: string;
    detail?: string;
    resultText?: string;
    expand?: ToolExpandView;
  },
): StreamThreadItem {
  const registryName = item.toolName;
  const rawDetail = opts?.detail ?? item.detail;
  const resultText = opts?.resultText ?? item.resultText;
  // Prefer the structured result text (full tool JSON) over the human "Done"
  // detail when building the expand view, so cards keep their real content.
  const expandSource = resultText ?? rawDetail;
  const expand =
    opts?.expand ??
    (expandSource
      ? buildToolExpandView(registryName, item.toolArgs, expandSource, status)
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
    resultText,
    expand,
    toolArgs: item.toolArgs,
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
  /** Full structured tool output (JSON) — preferred source for the expand view. */
  resultText?: string;
  /** Pre-built expand view (e.g. from streamThreadItemFromActivity). */
  expand?: ToolExpandView;
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
    resultText: payload.resultText,
    expand: payload.expand,
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
      {
        summary: opts?.summary,
        detail: opts?.detail,
        resultText: opts?.resultText,
        expand: opts?.expand,
      },
    );
    return next;
  }

  return completeLastRunningStreamTool(items, status, opts);
}

/** Mark the most recent running tool card done (fallback when tool:end has no id). */
export function completeLastRunningStreamTool(
  items: StreamThreadItem[],
  status: StreamThreadToolStatus = "done",
  opts?: {
    summary?: string;
    detail?: string;
    resultText?: string;
    expand?: ToolExpandView;
  },
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

  if (item.type === "tool_use") {
    const registryName = (item.toolName ?? "").trim() || "tool";
    const activityId = (item.id ?? "").trim();
    const stableId =
      item.parentDelegationId && activityId ? activityId : registryName;
    const isRunning =
      item.status === "running" || item.status === "active";
    const status: StreamThreadToolStatus = isRunning
      ? "running"
      : item.status === "error"
        ? "error"
        : "done";

    let rawDetail = (item.resultText ?? item.detail)?.trim();
    if (isRunning && looksLikeToolArgsJson(rawDetail)) {
      rawDetail = undefined;
    }

    const expand =
      !isRunning && rawDetail
        ? buildToolExpandView(
            registryName,
            item.toolArgs,
            rawDetail,
            status,
          )
        : undefined;

    const runningSummary =
      item.label?.trim() || getToolRunningSummary(registryName);

    return {
      kind: "tool",
      id: stableId,
      toolName: registryName,
      summary: isRunning
        ? runningSummary
        : summarizeToolActivityItem(item) ||
          getToolCompletedSummary(registryName),
      detail: rawDetail,
      expand,
      toolArgs: item.toolArgs,
      resultText: item.resultText,
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

const SUBAGENT_PROGRESS_THOUGHT_PREFIX = "sub-progress-";
const MAX_SUBAGENT_PROGRESS_LINES = 32;

/** Append progress lines in the sub-agent dropdown (keeps prior tool + status history). */
function appendSubagentProgressThought(
  nested: StreamThreadItem[],
  snippet: string,
  ts: number,
): StreamThreadItem[] {
  const trimmed = snippet.trim();
  if (!trimmed) return nested;

  const lastProgress = [...nested]
    .reverse()
    .find(
      (i): i is Extract<StreamThreadItem, { kind: "thought" }> =>
        i.kind === "thought" &&
        i.id.startsWith(SUBAGENT_PROGRESS_THOUGHT_PREFIX),
    );
  if (lastProgress?.content === trimmed) return nested;

  const progressLines = nested.filter(
    (i) =>
      i.kind === "thought" && i.id.startsWith(SUBAGENT_PROGRESS_THOUGHT_PREFIX),
  );
  const other = nested.filter(
    (i) =>
      !(i.kind === "thought" && i.id.startsWith(SUBAGENT_PROGRESS_THOUGHT_PREFIX)),
  );
  const nextProgress = [
    ...progressLines,
    {
      kind: "thought" as const,
      id: `${SUBAGENT_PROGRESS_THOUGHT_PREFIX}${ts}`,
      content: trimmed,
      ts,
    },
  ].slice(-MAX_SUBAGENT_PROGRESS_LINES);

  return [...other, ...nextProgress];
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
    const next = upsertAgent({
      id: subId,
      agentType,
      label: item.label ?? `${agentType}`,
      scope: item.scope,
      status: "running",
      nestedItems: existingAgent?.nestedItems ?? [],
    });
    return consolidateSubagentRoundsInThread(next);
  }

  if (item.type === "subagent_progress") {
    const snippet = item.preview?.trim() || item.detail?.trim();
    const nestedItems = snippet
      ? appendSubagentProgressThought(
          existingAgent?.nestedItems ?? [],
          snippet,
          ts,
        )
      : (existingAgent?.nestedItems ?? []);
    const next = upsertAgent({
      id: subId,
      agentType,
      label: existingAgent?.label ?? item.label ?? agentType,
      scope: item.scope ?? existingAgent?.scope,
      summary: snippet ?? existingAgent?.summary,
      status: "running",
      nestedItems,
    });
    return consolidateSubagentRoundsInThread(next);
  }

  if (item.type === "subagent_complete") {
    const summary =
      item.result?.trim() ||
      item.preview?.trim() ||
      item.detail?.trim() ||
      existingAgent?.summary;
    const next = upsertAgent({
      id: subId,
      agentType,
      label: existingAgent?.label ?? item.label ?? agentType,
      scope: item.scope ?? existingAgent?.scope,
      summary,
      status: item.status === "error" ? "error" : "done",
      nestedItems: existingAgent?.nestedItems ?? [],
    });
    return consolidateSubagentRoundsInThread(next);
  }

  return items;
}

function mergeNestedItemLists(
  primary: StreamThreadItem[],
  secondary: StreamThreadItem[],
): StreamThreadItem[] {
  let next = [...primary];
  for (const item of secondary) {
    next = upsertNestedStreamThreadItem(next, item);
  }
  return next;
}

/** True when the label is a raw delegation id (not a human title). */
export function isDelegationIdLabel(label: string | undefined): boolean {
  if (!label?.trim()) return false;
  return /^delegation-\d+/i.test(label.trim());
}

/** Prefer scoped sub-agent titles over generic delegation stubs. */
export function pickSubagentDisplayLabel(
  a?: string,
  b?: string,
): string {
  const score = (label: string | undefined): number => {
    if (!label?.trim()) return -1;
    const t = label.trim();
    if (isDelegationIdLabel(t)) return -10;
    if (t.startsWith("Mapping:")) return 4;
    if (t.startsWith("Agent team:")) return 0;
    if (t.includes("·")) return 3;
    if (t.startsWith("Sub-agent:")) return 1;
    return 2;
  };
  const sa = score(a);
  const sb = score(b);
  if (sa > sb) return a!.trim();
  if (sb > sa) return b!.trim();
  return a?.trim() || b?.trim() || "agent";
}

/** Resolve card title when activity only has delegation ids. */
export function resolveSubagentCardLabel(
  entry: Pick<SubAgentRunEntry, "label" | "scope" | "agentType">,
): string {
  const candidates = [entry.label, entry.scope].filter(Boolean) as string[];
  for (const c of candidates) {
    const t = c.trim();
    if (!isDelegationIdLabel(t)) return t;
  }
  const scope = entry.scope?.trim();
  if (scope) {
    return scope.startsWith("Mapping:") ? scope : `Mapping: ${scope}`;
  }
  const type = entry.agentType?.trim() || "agent";
  if (type.includes("·")) return type;
  const humanType = type.charAt(0).toUpperCase() + type.slice(1);
  return `Sub-agent: ${humanType}`;
}

function finalizeSubagentEntry(entry: SubAgentRunEntry): SubAgentRunEntry {
  const merged = pickSubagentDisplayLabel(entry.label, entry.scope);
  const label = isDelegationIdLabel(merged)
    ? resolveSubagentCardLabel(entry)
    : merged;
  return { ...entry, label };
}

/** Union sub-agent rows by id; thread nestedItems win over empty activity stubs. */
export function mergeSubAgentRunEntries(
  primary: SubAgentRunEntry[],
  secondary: SubAgentRunEntry[],
): SubAgentRunEntry[] {
  const map = new Map<string, SubAgentRunEntry>();
  for (const entry of [...primary, ...secondary]) {
    const prev = map.get(entry.id);
    if (!prev) {
      map.set(entry.id, {
        ...entry,
        nestedItems: [...entry.nestedItems],
      });
      continue;
    }
    const status: StreamThreadToolStatus =
      entry.status === "running"
        ? "running"
        : entry.status === "error"
          ? "error"
          : entry.status === "done"
            ? "done"
            : prev.status;
    map.set(entry.id, {
      ...prev,
      ...entry,
      label: pickSubagentDisplayLabel(prev.label, entry.label),
      scope: entry.scope ?? prev.scope,
      summary: entry.summary ?? prev.summary,
      status,
      nestedItems: mergeNestedItemLists(prev.nestedItems, entry.nestedItems),
    });
  }
  return [...map.values()].map(finalizeSubagentEntry);
}

function collectAgentsFromSubagentRounds(
  liveThread: StreamThreadItem[],
): { agents: SubAgentRunEntry[]; roundId: string; ts: number } | null {
  const rounds = liveThread.filter(
    (i): i is Extract<StreamThreadItem, { kind: "subagent_round" }> =>
      i.kind === "subagent_round",
  );
  if (!rounds.length) return null;
  let agents: SubAgentRunEntry[] = [];
  for (const round of rounds) {
    agents = mergeSubAgentRunEntries(agents, round.agents);
  }
  return {
    agents,
    roundId: rounds[0]!.id,
    ts: Math.min(...rounds.map((r) => r.ts)),
  };
}

function buildSubagentAgentsFromActivity(
  scoped: ActivityStreamItem[],
): SubAgentRunEntry[] {
  const sorted = [...scoped].sort(
    (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0),
  );
  const byId = new Map<string, SubAgentRunEntry>();

  const ensureAgent = (
    id: string,
    init: () => SubAgentRunEntry,
  ): SubAgentRunEntry => {
    const existing = byId.get(id);
    if (existing) return existing;
    const created = init();
    byId.set(id, created);
    return created;
  };

  for (const item of sorted) {
    if (item.type === "subagent_start") {
      const id = item.id?.trim() || `sub-${item.timestamp ?? Date.now()}`;
      const agent = ensureAgent(id, () => ({
        id,
        agentType: String(item.agentType ?? item.agent ?? "agent"),
        label: item.label ?? String(item.agent ?? "agent"),
        scope: item.scope,
        status: "running",
        nestedItems: [],
      }));
      agent.label = pickSubagentDisplayLabel(agent.label, item.label);
      agent.scope = item.scope ?? agent.scope;
      continue;
    }

    if (item.type === "subagent_progress") {
      const id = item.id?.trim();
      if (!id) continue;
      const agent = ensureAgent(id, () => ({
        id,
        agentType: String(item.agentType ?? item.agent ?? "agent"),
        label: item.label ?? String(item.agent ?? "agent"),
        scope: item.scope,
        status: "running",
        nestedItems: [],
      }));
      const snippet = item.preview?.trim() || item.detail?.trim();
      if (snippet) {
        agent.summary = snippet;
        agent.nestedItems = appendSubagentProgressThought(
          agent.nestedItems,
          snippet,
          item.timestamp ?? Date.now(),
        );
      }
      agent.label = pickSubagentDisplayLabel(agent.label, item.label);
      agent.scope = item.scope ?? agent.scope;
      continue;
    }

    if (
      (item.type === "tool_use") &&
      item.parentDelegationId?.trim()
    ) {
      const parentId = item.parentDelegationId.trim();
      const nested = streamThreadItemFromActivity(item);
      if (!nested) continue;
      const agentType = String(item.agentType ?? item.agent ?? "agent");
      const scope = item.scope;
      const agent = ensureAgent(parentId, () => ({
        id: parentId,
        agentType,
        label: scope
          ? scope.startsWith("Mapping:")
            ? scope
            : `Mapping: ${scope}`
          : pickSubagentDisplayLabel(item.label, undefined),
        scope,
        status: "running",
        nestedItems: [],
      }));
      agent.agentType = agentType;
      agent.scope = scope ?? agent.scope;
      agent.label = pickSubagentDisplayLabel(
        agent.label,
        item.label ?? (scope ? `Mapping: ${scope}` : undefined),
      );
      agent.nestedItems = upsertNestedStreamThreadItem(
        agent.nestedItems,
        nested,
      );
      if (nested.kind === "tool" && nested.summary.trim()) {
        agent.summary = nested.summary.trim();
      } else if (item.label?.trim()) {
        agent.summary = item.label.trim();
      }
      continue;
    }

    if (item.type === "subagent_complete") {
      const id = item.id?.trim();
      if (!id) continue;
      const status: StreamThreadToolStatus =
        item.status === "error" ? "error" : "done";
      const summary =
        item.result?.trim() || item.preview?.trim() || item.detail?.trim();
      const agent = ensureAgent(id, () => ({
        id,
        agentType: String(item.agentType ?? item.agent ?? "agent"),
        label: item.label ?? String(item.agent ?? "agent"),
        scope: item.scope,
        status,
        summary,
        nestedItems: [],
      }));
      agent.status = status;
      agent.summary = summary ?? agent.summary;
      agent.label = pickSubagentDisplayLabel(agent.label, item.label);
      agent.scope = item.scope ?? agent.scope;
    }
  }

  return [...byId.values()].map(finalizeSubagentEntry);
}

/** Nest a tool/thought activity under a sub-agent card inside the active round. */
export function mergeNestedActivityIntoSubagentRound(
  items: StreamThreadItem[],
  parentDelegationId: string,
  nested: StreamThreadItem,
  roundId?: string,
): StreamThreadItem[] {
  const resolvedRoundId =
    roundId?.trim() ||
    items.find((i) => i.kind === "subagent_round")?.id ||
    "subagent-round";
  const next = upsertSubagentRound(items, resolvedRoundId, (agents) => {
    const idx = agents.findIndex((a) => a.id === parentDelegationId);
    if (idx >= 0) {
      const copy = [...agents];
      copy[idx] = {
        ...copy[idx]!,
        nestedItems: upsertNestedStreamThreadItem(
          copy[idx]!.nestedItems,
          nested,
        ),
      };
      return copy;
    }
    return [
      ...agents,
      {
        id: parentDelegationId,
        agentType: "agent",
        label: parentDelegationId,
        status: "running" as const,
        nestedItems: [nested],
      },
    ];
  });
  return consolidateSubagentRoundsInThread(next);
}

/** Route sub-agent tool IPC into nested cards only (creates stub agent if needed). */
export function mergeNestedToolActivityIntoSubagentRound(
  items: StreamThreadItem[],
  parentDelegationId: string,
  activity: ActivityStreamItem,
): StreamThreadItem[] {
  const nested = streamThreadItemFromActivity(activity);
  if (!nested) return items;
  return mergeNestedActivityIntoSubagentRound(
    items,
    parentDelegationId,
    nested,
    activity.roundId,
  );
}

function isExpandableToolItem(
  item: Extract<StreamThreadItem, { kind: "tool" }>,
): boolean {
  return Boolean(item.expand && item.expand.kind !== "none");
}

/** Merge IPC-frozen tools with tag-parsed content so expand/detail survive persist. */
export function enrichStreamThreadFromAssistantContent(
  items: StreamThreadItem[],
  assistantContent: string,
): StreamThreadItem[] {
  if (!assistantContent.trim()) return items;

  const fromContent = buildCompletedStreamThreadFromAssistantContent(
    assistantContent,
  );
  const contentToolsByName = new Map<
    string,
    Extract<StreamThreadItem, { kind: "tool" }>[]
  >();
  for (const item of fromContent) {
    if (item.kind !== "tool") continue;
    const list = contentToolsByName.get(item.toolName) ?? [];
    list.push(item);
    contentToolsByName.set(item.toolName, list);
  }

  const usedByName = new Map<string, number>();
  const enrichTool = (
    tool: Extract<StreamThreadItem, { kind: "tool" }>,
  ): Extract<StreamThreadItem, { kind: "tool" }> => {
    const idx = usedByName.get(tool.toolName) ?? 0;
    usedByName.set(tool.toolName, idx + 1);
    const contentTool = contentToolsByName.get(tool.toolName)?.[idx];
    if (!contentTool) return tool;
    if (isExpandableToolItem(tool)) return tool;
    if (!isExpandableToolItem(contentTool)) return tool;
    return {
      ...tool,
      expand: contentTool.expand,
      detail: contentTool.detail ?? tool.detail,
      resultText: contentTool.resultText ?? tool.resultText,
      summary: contentTool.summary || tool.summary,
    };
  };

  let next = items.map((item) => {
    if (item.kind === "tool") return enrichTool(item);
    if (item.kind === "subagent_round") {
      return {
        ...item,
        agents: item.agents.map((agent) => ({
          ...agent,
          nestedItems: enrichStreamThreadFromAssistantContent(
            agent.nestedItems,
            assistantContent,
          ),
        })),
      };
    }
    if (item.kind === "subagent" && item.nestedItems) {
      return {
        ...item,
        nestedItems: enrichStreamThreadFromAssistantContent(
          item.nestedItems,
          assistantContent,
        ),
      };
    }
    return item;
  });

  if (!next.some((i) => i.kind === "thought")) {
    const thoughts = fromContent.filter(
      (i): i is Extract<StreamThreadItem, { kind: "thought" }> =>
        i.kind === "thought",
    );
    if (thoughts.length > 0) {
      next = [...thoughts, ...next];
    }
  }

  return next;
}

/** Pin live stream-thread cards to an assistant message before clearing the chat map. */
export function freezeStreamThreadForAssistantMessage(
  items: StreamThreadItem[],
  thoughtContent?: string | null,
  assistantContent?: string | null,
): StreamThreadItem[] {
  let finalized = finalizeAllRunningStreamTools(items);
  finalized = finalizeRunningBackgroundItems(finalized);
  finalized = flattenToolGroupsInThread(finalized);
  if (assistantContent?.trim()) {
    finalized = enrichStreamThreadFromAssistantContent(
      finalized,
      assistantContent,
    );
  }
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
    (p): p is Extract<AssistantMessagePart, { type: "tool" }> =>
      p.type === "tool" && isDelegateToolName(p.toolName),
  );
  const withMeta = delegates
    .map((p) => ({ part: p, handoff: delegateDisplayMetaFromToolPart(p) }))
    .filter(
      (
        row,
      ): row is {
        part: Extract<AssistantMessagePart, { type: "tool" }>;
        handoff: DelegateHandoffMeta;
      } => row.handoff != null && Boolean(row.handoff.summary?.trim()),
    );
  if (!withMeta.length) return null;

  const agents: SubAgentRunEntry[] = withMeta.map(({ part: p, handoff }, index) => ({
    id: `handoff-${p.id}-${index}`,
    agentType: handoff.agentRole,
    label: handoff.scope
      ? `${handoff.agentRole} · ${handoff.scope}`
      : handoff.agentRole,
    scope: handoff.scope,
    summary: handoff.summary,
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

export function hasDelegateToolParts(parts: AssistantMessagePart[]): boolean {
  return parts.some(
    (p) => p.type === "tool" && isDelegateToolName(p.toolName),
  );
}

export function hasActiveSubagentActivity(
  items: ActivityStreamItem[],
  chatId: number | null | undefined,
): boolean {
  if (chatId == null) return false;
  const scoped = items.filter((i) => i.chatId == null || i.chatId === chatId);
  return scoped.some(
    (i) =>
      i.type === "subagent_start" ||
      i.type === "subagent_progress" ||
      i.type === "subagent_complete" ||
      i.type === "delegation_complete" ||
      i.type === "delegation_error" ||
      (i.type === "delegation_start" &&
        (i.status === "active" || i.status === "running")),
  );
}

/** Merge duplicate subagent_round rows (e.g. default id vs turnId) into one panel. */
export function consolidateSubagentRoundsInThread(
  items: StreamThreadItem[],
): StreamThreadItem[] {
  const rounds = items.filter(
    (i): i is Extract<StreamThreadItem, { kind: "subagent_round" }> =>
      i.kind === "subagent_round",
  );
  if (rounds.length <= 1) return items;

  let agents: SubAgentRunEntry[] = [];
  for (const round of rounds) {
    agents = mergeSubAgentRunEntries(agents, round.agents);
  }
  const roundId =
    rounds.find((r) => r.agents.some((a) => a.status === "running"))?.id ??
    rounds[rounds.length - 1]!.id;

  const merged: Extract<StreamThreadItem, { kind: "subagent_round" }> = {
    kind: "subagent_round",
    id: roundId,
    agents,
    status: roundStatus(agents),
    ts: Math.min(...rounds.map((r) => r.ts)),
  };

  return [...items.filter((i) => i.kind !== "subagent_round"), merged];
}

/** Split message parts so the sub-agent round panel can render at the first delegate tool. */
export function splitInterleavedAroundDelegates(
  parts: AssistantMessagePart[],
): { before: AssistantMessagePart[]; after: AssistantMessagePart[] } {
  const idx = parts.findIndex(
    (p) => p.type === "tool" && isDelegateToolName(p.toolName),
  );
  if (idx < 0) {
    return { before: parts, after: [] };
  }
  const before = parts.slice(0, idx);
  const after = parts
    .slice(idx + 1)
    .filter(
      (p) => !(p.type === "tool" && isDelegateToolName(p.toolName)),
    );
  return { before, after };
}

/** Prefer merged IPC round; union with activity so completed agents are never dropped. */
export function resolveLiveSubagentRound(args: {
  liveThread: StreamThreadItem[];
  activityItems: ActivityStreamItem[];
  chatId: number;
}): Extract<StreamThreadItem, { kind: "subagent_round" }> | null {
  const fromThread = collectAgentsFromSubagentRounds(
    consolidateSubagentRoundsInThread(args.liveThread),
  );
  const scoped = args.activityItems.filter(
    (i) => i.chatId == null || i.chatId === args.chatId,
  );
  const fromActivity = buildSubagentAgentsFromActivity(scoped);
  const agents = mergeSubAgentRunEntries(
    fromThread?.agents ?? [],
    fromActivity,
  );
  if (agents.length === 0) return null;

  const roundId =
    fromThread?.roundId ||
    scoped.find((i) => i.roundId)?.roundId?.trim() ||
    "subagent-round-provisional";

  return {
    kind: "subagent_round",
    id: roundId,
    agents,
    status: roundStatus(agents),
    ts: fromThread?.ts ?? Date.now(),
  };
}

function assistantPartToStreamItem(
  part: AssistantMessagePart,
  ts: number,
): StreamThreadItem | null {
  if (part.type === "thought") {
    return {
      kind: "thought",
      id: `thought-${ts}`,
      content: part.content,
      ts,
    };
  }
  if (part.type === "plan_artifact") {
    return { kind: "plan", planId: part.planId, ts };
  }
  if (part.type !== "tool") return null;

  const status: StreamThreadToolStatus =
    part.status === "running"
      ? "running"
      : part.status === "error"
        ? "error"
        : "done";
  const registryName = part.toolName;
  const rawDetail = part.resultText?.trim();
  const expand =
    rawDetail && status !== "running"
      ? buildToolExpandView(registryName, undefined, rawDetail, status)
      : undefined;
  const preview =
    rawDetail && status === "done"
      ? formatToolResultPreview(registryName, rawDetail, "done")
      : undefined;
  const summary =
    preview?.trim() ||
    (status === "running"
      ? getToolRunningSummary(registryName)
      : getToolCompletedSummary(registryName));

  return {
    kind: "tool",
    id: part.id || registryName,
    toolName: registryName,
    summary,
    detail: rawDetail,
    expand,
    status,
    ts,
  };
}

/** Rebuild frozen stream-thread cards from persisted assistant message tags. */
export function buildCompletedStreamThreadFromAssistantContent(
  content: string,
): StreamThreadItem[] {
  if (!content.trim()) return [];
  const parts = parseAssistantMessageParts(content, false);
  const items: StreamThreadItem[] = [];
  let ts = 0;
  for (const part of parts) {
    if (part.type === "markdown") continue;
    const item = assistantPartToStreamItem(part, ts++);
    if (item) items.push(item);
  }
  if (!items.some((i) => i.kind === "subagent_round")) {
    const round = synthesizeSubagentRoundFromParts(parts);
    if (round) items.push(round);
  }
  return flattenToolGroupsInThread(consolidateSubagentRoundsInThread(items));
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
