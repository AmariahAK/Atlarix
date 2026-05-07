/**
 * ThoughtsPanel — WhatsApp-style agent group chat.
 *
 * Refactor: ThoughtsPanel
 * - Data source: activityStreamItemsAtom only (renderer-side derivation).
 * - Main (leader) appears on the right; delegated agents on the left.
 */
 
import React, { useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { activityStreamItemsAtom, type ActivityStreamItem } from "@/atoms/sourceAtoms";
import {
  activeChatIdAtom,
  lastReasoningTokensByChatIdAtom,
  selectedChatIdAtom,
} from "@/atoms/chatAtoms";
import { cn } from "@/lib/utils";
import { X, Check, AlertTriangle, Loader2 } from "lucide-react";
 
interface ThoughtsPanelProps {
  onClose?: () => void;
  /** `inline`: embedded in chat (bounded height). `sidebar`: fills parent (e.g. right panel). */
  variant?: "sidebar" | "inline";
}
 
type Side = "left" | "right";
type BubbleStatus = "active" | "done" | "error";
 
const COUNSEL_ROW_TYPES = new Set<ActivityStreamItem["type"]>([
  "counsel_start",
  "counsel_participant_complete",
  "counsel_synthesising",
  "counsel_complete",
  "counsel_timeout",
]);

type ThoughtBubble = {
  id: string;
  side: Side;
  speakerId: string;
  speakerLabel: string;
  status: BubbleStatus;
  text: string;
  timestamp: number;
  /** Source activity row type (for accurate tool counts). */
  activityType?: ActivityStreamItem["type"];
  /** Near-simultaneous agent_message cluster (ThoughtsPanel row). */
  parallelGroupId?: string;
  /** One counsel session (multi-perspective run), keyed by sessionId. */
  counselGroupId?: string;
  /** From counsel_start.activity (participant count). */
  counselParticipantCount?: number;
};
 
const AGENT_ORDER = ["research", "architect", "builder", "debugger", "reviewer"] as const;
const AGENT_COLORS: Record<string, string> = {
  main: "#10b981",
  research: "#38bdf8",
  architect: "#a78bfa",
  builder: "#f59e0b",
  debugger: "#fb7185",
  reviewer: "#22c55e",
};
 
function titleCase(s: string) {
  return (s || "").replace(/^./, (c) => c.toUpperCase());
}
 
function hashToInt(input: string) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
 
function buildPixelAvatarPattern(seed: string, size = 6) {
  // Deterministic (seeded) 6x6 pattern: symmetric horizontally for a “pixel icon” feel.
  const bits: boolean[][] = [];
  const base = hashToInt(seed);
  for (let y = 0; y < size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < Math.ceil(size / 2); x++) {
      const n = hashToInt(`${base}:${x}:${y}`);
      row.push((n % 7) < 3); // ~43% filled
    }
    const full = [...row, ...row.slice(0, Math.floor(size / 2)).reverse()];
    bits.push(full.slice(0, size));
  }
  return bits;
}
 
function PixelAvatar({
  id,
  color,
  status,
}: {
  id: string;
  color: string;
  status: BubbleStatus;
}) {
  const pattern = useMemo(() => buildPixelAvatarPattern(id), [id]);
  const ring =
    status === "error"
      ? "ring-rose-500/50"
      : status === "done"
        ? "ring-emerald-500/40"
        : "ring-amber-500/40";
  return (
    <div
      className={cn(
        "relative shrink-0 rounded-lg bg-[#0b0b0b] p-1 ring-2",
        ring,
      )}
      style={{ boxShadow: `0 0 0 1px ${color}20 inset` }}
      aria-hidden
    >
      <div className="grid grid-cols-6 gap-[1px]">
        {pattern.flatMap((row, y) =>
          row.map((on, x) => (
            <span
              // eslint-disable-next-line react/no-array-index-key
              key={`${x}-${y}`}
              className="block h-[3px] w-[3px] rounded-[1px]"
              style={{
                background: on ? color : "transparent",
                opacity: on ? 0.95 : 1,
              }}
            />
          )),
        )}
      </div>
      {status === "active" ? (
        <span className="absolute -bottom-1 -right-1 h-2.5 w-2.5 rounded-full bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.6)] animate-pulse" />
      ) : null}
    </div>
  );
}
 
function speakerLabelFor(item: ActivityStreamItem): { id: string; label: string; side: Side } {
  // Main/leader messages: right side
  if (
    item.type === "routing_decision" ||
    item.type === "classifier_routing" ||
    item.type === "turn_summary" ||
    item.type === "mode_change"
  ) {
    return { id: "main", label: "Main", side: "right" };
  }
 
  if (item.type === "orchestrator_blocker") {
    return { id: "orchestrator", label: "Orchestrator", side: "left" };
  }

  if (
    item.type === "parallel_prefetch_start" ||
    item.type === "parallel_prefetch_complete"
  ) {
    return { id: "parallel", label: "Parallel", side: "left" };
  }

  if (item.type === "build_verification_complete") {
    return { id: "build-verify", label: "Build verify", side: "left" };
  }

  if (item.type === "memory_saved") {
    return { id: "auto-memory", label: "Auto memory", side: "left" };
  }

  if (item.type === "counsel_participant_complete") {
    const role = item.counselRole ? String(item.counselRole).toLowerCase() : "peer";
    const label =
      role === "fast"
        ? "Fast"
        : role === "balanced"
          ? "Balanced"
          : role === "thinking"
            ? "Thinking"
            : titleCase(role);
    return { id: `counsel-${role}`, label, side: "left" };
  }
  if (item.type === "counsel_synthesising") {
    return { id: "counsel-synthesis", label: "Counsel", side: "right" };
  }
  if (item.type === "counsel_complete") {
    return { id: "counsel-synthesis", label: "Counsel", side: "right" };
  }
  if (item.type === "counsel_timeout") {
    return { id: "counsel-synthesis", label: "Counsel", side: "right" };
  }
  if (item.type === "counsel_start") {
    return { id: "counsel-system", label: "Counsel", side: "left" };
  }

  if (item.type === "reasoning_started" || item.type === "reasoning_complete") {
    return { id: "model-reasoning", label: "Model", side: "right" };
  }

  // Agent bus messages: fromAgent is the speaker (left)
  if (item.type === "agent_message" && item.fromAgent) {
    const from = String(item.fromAgent);
    return { id: from, label: titleCase(from), side: "left" };
  }
 
  // Delegation events: the delegated agent is the speaker (left)
  if (
    (item.type === "delegation_start" ||
      item.type === "delegation_complete" ||
      item.type === "delegation_error" ||
      item.type === "delegation") &&
    item.agent
  ) {
    const a = String(item.agent).toLowerCase();
    return { id: a, label: titleCase(a), side: "left" };
  }
 
  // Tool use typically isn’t tagged with agent; show on the right as Main/system.
  return { id: "main", label: "Main", side: "right" };
}
 
function statusFor(item: ActivityStreamItem): BubbleStatus {
  if (item.type === "orchestrator_blocker") return "error";
  if (item.status === "error" || item.type === "delegation_error") return "error";
  if (item.status === "done" || item.type === "delegation_complete") return "done";
  return "active";
}
 
function bubbleTextFor(item: ActivityStreamItem): string {
  switch (item.type) {
    case "routing_decision":
      return item.detail?.trim() || item.label?.trim() || "Routing decision";
    case "classifier_routing":
      return item.label?.trim() || "Classifier";
    case "orchestrator_blocker": {
      const head = item.label?.trim() || "Blocker";
      const body = item.detail?.trim();
      return body ? `${head}\n${body}` : head;
    }
    case "agent_message": {
      const from = item.fromAgent ? String(item.fromAgent) : "agent";
      const to = item.toAgent ? String(item.toAgent) : "agent";
      const body = item.detail?.trim() || item.result?.trim() || item.label?.trim();
      return body ? `${from} → ${to}\n${body}` : `${from} → ${to}`;
    }
    case "delegation_start":
      return item.task?.trim()
        ? `Starting: ${item.task.trim()}`
        : item.label?.trim() || "Delegation started";
    case "delegation_complete":
    case "delegation_error":
      return item.result?.trim() || item.detail?.trim() || item.label?.trim() || "Delegation finished";
    case "tool_use":
      return item.detail?.trim() || item.label?.trim() || "Tool used";
    case "parallel_prefetch_start":
    case "parallel_prefetch_complete":
      return item.label?.trim() || item.type;
    case "build_verification_complete":
      return item.detail?.trim() || item.label?.trim() || "Build verification complete";
    case "memory_saved":
      return item.detail?.trim() || item.label?.trim() || "Memory saved";
    case "counsel_participant_complete": {
      const role = item.counselRole ? titleCase(item.counselRole) : "Participant";
      const body = item.preview?.trim();
      return body ? `${role}: ${body}` : `${role} complete`;
    }
    case "counsel_thinking": {
      const role = item.counselRole ? titleCase(item.counselRole) : "Counsel";
      const detail = item.detail?.trim();
      return detail ? `${role}: ${detail}` : `${role} thinking...`;
    }
    case "counsel_start": {
      const n = item.participantCount ?? 3;
      return `${n} perspectives`;
    }
    case "counsel_synthesising":
      return "Combining perspectives…";
    case "counsel_complete": {
      const len = item.synthesisLength;
      return typeof len === "number" && len > 0
        ? `Done — ${len.toLocaleString()} characters`
        : "Done";
    }
    case "counsel_timeout": {
      const tail = item.detail?.trim();
      return tail || "Counsel timed out — partial results kept";
    }
    case "duration_limit_reached": {
      const head = item.label?.trim() || "Task paused after 30 minutes";
      const tail = item.detail?.trim();
      return tail ? `${head} — ${tail}` : head;
    }
    case "loop_detected": {
      const head = item.label?.trim() || "Repeated action detected";
      const tail = item.detail?.trim();
      return tail ? `${head}\n${tail}` : head;
    }
    case "loop_repetition_aborted": {
      const head = item.label?.trim() || "Task stopped — repeated action";
      const tail = item.detail?.trim();
      return tail ? `${head}\n${tail}` : head;
    }
    case "reasoning_started":
      return item.label?.trim() || "Thinking deeply...";
    case "reasoning_complete":
      return item.label?.trim() || "Done thinking, writing response...";
    default:
      return item.detail?.trim() || item.label?.trim() || item.type;
  }
}
 
function stableSort(items: ActivityStreamItem[]) {
  return [...items].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

const COUNSEL_ACTIVITY_TYPES = new Set<ActivityStreamItem["type"]>([
  "counsel_start",
  "counsel_thinking",
  "counsel_participant_complete",
  "counsel_synthesising",
  "counsel_complete",
  "counsel_timeout",
]);

/** Group counsel_* rows that share `sessionId` into one expandable block. */
function assignCounselSessionGroupIds(sorted: ActivityStreamItem[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const it of sorted) {
    if (!COUNSEL_ACTIVITY_TYPES.has(it.type)) continue;
    const sid = it.sessionId;
    if (typeof sid !== "string" || !sid) continue;
    out.set(it.id, `counsel-${sid}`);
  }
  return out;
}

/** Cluster consecutive agent_message rows within 2s (parallel bus traffic). */
function assignParallelAgentGroupIds(sorted: ActivityStreamItem[]): Map<string, string> {
  const out = new Map<string, string>();
  const cluster: ActivityStreamItem[] = [];
  const flush = () => {
    if (cluster.length >= 2) {
      const first = cluster[0]!;
      const gid = `pg-${first.timestamp}-${first.id}`;
      for (const c of cluster) out.set(c.id, gid);
    }
    cluster.length = 0;
  };
  for (const it of sorted) {
    if (it.type === "agent_message" && it.fromAgent) {
      const last = cluster[cluster.length - 1];
      if (
        !last ||
        Math.abs((it.timestamp ?? 0) - (last.timestamp ?? 0)) <= 2000
      ) {
        cluster.push(it);
      } else {
        flush();
        cluster.push(it);
      }
    } else {
      flush();
    }
  }
  flush();
  return out;
}

function thoughtStatusIcon(status: BubbleStatus) {
  if (status === "active") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />;
  }
  if (status === "done") {
    return <Check className="h-3.5 w-3.5 text-emerald-500" />;
  }
  return <AlertTriangle className="h-3.5 w-3.5 text-rose-500" />;
}

/** One thought bubble row: correct lane (e.g. counsel participant left, main right; agent bus left). */
function laneThoughtBubbleRow(b: ThoughtBubble) {
  const isRight = b.side === "right";
  const bid = b.speakerId.split("_")[0] ?? b.speakerId;
  const color = AGENT_COLORS[bid] ?? AGENT_COLORS.main;
  const rowToolCount = b.activityType === "tool_use" ? 1 : 0;
  return (
    <div
      key={b.id}
      className={cn("flex items-end gap-2", isRight ? "justify-end" : "justify-start")}
    >
      {!isRight ? <PixelAvatar id={b.speakerId} color={color} status={b.status} /> : null}
      <div className={cn("max-w-[80%] min-w-[10rem]")}>
        <div
          className={cn(
            "text-[11px] mb-1 flex items-center gap-2",
            isRight ? "justify-end text-emerald-200/70" : "justify-start text-slate-200/70",
          )}
        >
          <span className="font-medium" style={{ color }}>
            {b.speakerLabel}
          </span>
          {rowToolCount > 0 ? (
            <span className="text-[10px] opacity-60">Tools used: {rowToolCount}</span>
          ) : null}
          <span className="opacity-70">{thoughtStatusIcon(b.status)}</span>
        </div>
        <div
          className={cn(
            "rounded-2xl px-3 py-2 text-xs whitespace-pre-wrap break-words border",
            isRight
              ? "bg-emerald-500/10 border-emerald-500/20 text-slate-100"
              : "bg-[#1a1a1a] border-white/10 text-slate-200",
          )}
          style={{
            borderLeft: !isRight ? `3px solid ${color}55` : undefined,
            borderRight: isRight ? `3px solid ${color}55` : undefined,
          }}
        >
          {b.text}
        </div>
      </div>
      {isRight ? <PixelAvatar id={b.speakerId} color={color} status={b.status} /> : null}
    </div>
  );
}
 
function countToolUseInBubbles(bubbles: ThoughtBubble[]): number {
  let n = 0;
  for (const b of bubbles) {
    if (b.activityType === "tool_use") n += 1;
  }
  return n;
}

export function ThoughtsPanel({ onClose, variant = "sidebar" }: ThoughtsPanelProps) {
  const items = useAtomValue(activityStreamItemsAtom);
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const activeChatId = useAtomValue(activeChatIdAtom);
  const reasoningByChat = useAtomValue(lastReasoningTokensByChatIdAtom);
  const panelChatId = selectedChatId ?? activeChatId;
  const reasoningTokens =
    panelChatId != null ? reasoningByChat[panelChatId] : undefined;
  const [counselExpandedById, setCounselExpandedById] = useState<Record<string, boolean>>({});
 
  const bubbles: ThoughtBubble[] = useMemo(() => {
    const panelItems =
      panelChatId == null
        ? items
        : items.filter((i) => i.chatId == null || i.chatId === panelChatId);
    const sorted = stableSort(panelItems);
    const parallelGroupByItemId = assignParallelAgentGroupIds(sorted);
    const counselGroupByItemId = assignCounselSessionGroupIds(sorted);
    const out: ThoughtBubble[] = [];

    // Track “agent instances” to generate Research_1 / Architect_2 labels deterministically.
    const countsByAgent = new Map<string, number>();
    const instanceByDelegationId = new Map<string, { speakerId: string; speakerLabel: string }>();
 
    for (const it of sorted) {
      if (it.type === "routing_decision" || it.type === "classifier_routing") {
        continue;
      }

      const speaker = speakerLabelFor(it);
      let speakerId = speaker.id;
      let speakerLabel = speaker.label;

      // If this is a delegation event, create a numbered instance label per agent based on first appearance.
      if (
        (it.type === "delegation_start" ||
          it.type === "delegation_complete" ||
          it.type === "delegation_error") &&
        it.agent &&
        it.id
      ) {
        const a = String(it.agent).toLowerCase();
        const existing = instanceByDelegationId.get(it.id);
        if (existing) {
          speakerId = existing.speakerId;
          speakerLabel = existing.speakerLabel;
        } else {
          const next = (countsByAgent.get(a) ?? 0) + 1;
          countsByAgent.set(a, next);
          speakerId = `${a}_${next}`;
          speakerLabel = `${titleCase(a)} ${next}`;
          instanceByDelegationId.set(it.id, { speakerId, speakerLabel });
        }
      }
 
      // Prefer showing known roles without numbering when there’s no delegation id.
      if (speakerId === speaker.id && AGENT_ORDER.includes(speaker.id as any)) {
        speakerLabel = titleCase(speaker.id);
      }
 
      out.push({
        id: `${it.id}:${it.timestamp}`,
        side: speaker.side,
        speakerId,
        speakerLabel,
        status: statusFor(it),
        text: bubbleTextFor(it),
        timestamp: it.timestamp ?? Date.now(),
        activityType: it.type,
        parallelGroupId: parallelGroupByItemId.get(it.id),
        counselGroupId: counselGroupByItemId.get(it.id),
        counselParticipantCount: it.participantCount,
      });
    }
    return out;
  }, [items, panelChatId]);

  const hasCounselHeavyRows = useMemo(
    () =>
      bubbles.some(
        (b) => b.activityType != null && COUNSEL_ROW_TYPES.has(b.activityType),
      ),
    [bubbles],
  );
  const panelHeading = hasCounselHeavyRows ? "Counsel & activity" : "Thoughts";

  const grouped = useMemo(() => {
    type Group = {
      speakerId: string;
      speakerLabel: string;
      side: Side;
      status: BubbleStatus;
      color: string;
      last: ThoughtBubble[];
      toolCount: number;
      latestTs: number;
      /** Multiple agents shown in one row (parallel bus). */
      parallelMembers?: ThoughtBubble[];
      /** One counsel session; rendered inside expandable details. */
      counselMembers?: ThoughtBubble[];
    };
    const parallelClusters = new Map<string, ThoughtBubble[]>();
    for (const b of bubbles) {
      if (!b.parallelGroupId) continue;
      const arr = parallelClusters.get(b.parallelGroupId) ?? [];
      arr.push(b);
      parallelClusters.set(b.parallelGroupId, arr);
    }
    const counselClusters = new Map<string, ThoughtBubble[]>();
    for (const b of bubbles) {
      if (!b.counselGroupId) continue;
      const arr = counselClusters.get(b.counselGroupId) ?? [];
      arr.push(b);
      counselClusters.set(b.counselGroupId, arr);
    }
    const bySpeaker = new Map<string, Group>();
    const seenParallelGroup = new Set<string>();
    const seenCounselGroup = new Set<string>();
    for (const b of bubbles) {
      if (b.counselGroupId) {
        if (seenCounselGroup.has(b.counselGroupId)) continue;
        seenCounselGroup.add(b.counselGroupId);
        const cluster = counselClusters.get(b.counselGroupId);
        if (!cluster?.length) continue;
        const key = b.counselGroupId;
        const latestTs = Math.max(...cluster.map((x) => x.timestamp));
        const rank = (s: BubbleStatus) => (s === "error" ? 2 : s === "active" ? 1 : 0);
        let st: BubbleStatus = "done";
        for (const x of cluster) {
          if (rank(x.status) > rank(st)) st = x.status;
        }
        const pc = cluster.find((x) => x.counselParticipantCount != null)?.counselParticipantCount;
        bySpeaker.set(key, {
          speakerId: key,
          speakerLabel:
            pc != null ? `Counsel session (${pc} perspectives)` : "Counsel session",
          side: "left",
          status: st,
          color: AGENT_COLORS.architect,
          last: cluster,
          toolCount: countToolUseInBubbles(cluster),
          latestTs,
          counselMembers: cluster,
        });
        continue;
      }
      if (b.parallelGroupId) {
        if (seenParallelGroup.has(b.parallelGroupId)) continue;
        seenParallelGroup.add(b.parallelGroupId);
        const cluster = parallelClusters.get(b.parallelGroupId);
        if (!cluster?.length) continue;
        const key = `parallel:${b.parallelGroupId}`;
        const labels = cluster.map((x) => x.speakerLabel).join(" · ");
        const latestTs = Math.max(...cluster.map((x) => x.timestamp));
        const rank = (s: BubbleStatus) => (s === "error" ? 2 : s === "active" ? 1 : 0);
        let st: BubbleStatus = "done";
        for (const x of cluster) {
          if (rank(x.status) > rank(st)) st = x.status;
        }
        bySpeaker.set(key, {
          speakerId: key,
          speakerLabel: `Parallel: ${labels}`,
          side: "left",
          status: st,
          color: AGENT_COLORS.architect,
          last: cluster.slice(-3),
          toolCount: countToolUseInBubbles(cluster),
          latestTs,
          parallelMembers: cluster,
        });
        continue;
      }
      const key = b.speakerId;
      const baseId = key.split("_")[0];
      const color = AGENT_COLORS[baseId] ?? AGENT_COLORS.main;
      const existing = bySpeaker.get(key) ?? {
        speakerId: key,
        speakerLabel: b.speakerLabel,
        side: b.side,
        status: b.status,
        color,
        last: [],
        toolCount: 0,
        latestTs: 0,
      };
      existing.latestTs = Math.max(existing.latestTs, b.timestamp);

      if (b.text.trim().length > 0) {
        existing.last.push(b);
        if (existing.last.length > 3) existing.last.shift();
      }

      if (b.activityType === "tool_use") {
        existing.toolCount += 1;
      }

      // Status: error > active > done
      const rank = (s: BubbleStatus) => (s === "error" ? 2 : s === "active" ? 1 : 0);
      if (rank(b.status) > rank(existing.status)) existing.status = b.status;

      bySpeaker.set(key, existing);
    }
    return [...bySpeaker.values()].sort((a, b) => a.latestTs - b.latestTs);
  }, [bubbles]);

  const hasAny = grouped.length > 0;
  if (!hasAny) {
    return (
      <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
        <span className="flex flex-col gap-0.5">
          <span>{panelHeading}</span>
          {reasoningTokens != null && reasoningTokens > 0 ? (
            <span className="text-[10px] opacity-70">
              Reasoning tokens (last turn): {reasoningTokens.toLocaleString()}
            </span>
          ) : null}
        </span>
        {onClose ? (
          <button
            type="button"
            className="p-1 rounded hover:bg-muted"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    );
  }
 
  const rootClass = cn(
    "flex flex-col min-h-0",
    variant === "inline" ? "max-h-[40vh]" : "h-full",
  );
  const scrollBodyClass = cn(
    "overflow-y-auto overflow-x-hidden p-3 space-y-3 bg-[#0f0f0f]",
    variant === "inline" ? "max-h-[min(18rem,36vh)] min-h-0" : "flex-1 min-h-0",
  );

  return (
    <div className={rootClass}>
      <div className="flex shrink-0 items-center justify-between px-3 py-2 border-b border-border/40 bg-muted/10">
        <span className="text-xs font-medium flex flex-col gap-0.5">
          <span>{panelHeading}</span>
          {reasoningTokens != null && reasoningTokens > 0 ? (
            <span className="text-[10px] font-normal text-muted-foreground">
              Reasoning tokens (last turn): {reasoningTokens.toLocaleString()}
            </span>
          ) : null}
        </span>
        {onClose ? (
          <button
            type="button"
            className="p-1 rounded hover:bg-muted"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>
 
      <div className={scrollBodyClass}>
        {grouped.map((g) => {
          const isRight = g.side === "right";
          const statusIcon = thoughtStatusIcon(g.status);
 
          const rowInner = (
            <>
              {!isRight ? (
                g.parallelMembers && g.parallelMembers.length > 0 ? (
                  <div className="flex items-end gap-1 shrink-0">
                    {g.parallelMembers.map((m) => {
                      const bid = m.speakerId.split("_")[0] ?? m.speakerId;
                      const col = AGENT_COLORS[bid] ?? g.color;
                      return (
                        <PixelAvatar
                          key={m.id}
                          id={m.speakerId}
                          color={col}
                          status={m.status}
                        />
                      );
                    })}
                  </div>
                ) : (
                  <PixelAvatar id={g.speakerId} color={g.color} status={g.status} />
                )
              ) : null}

              <div className={cn("max-w-[80%] min-w-[10rem]")}>
                <div
                  className={cn(
                    "text-[11px] mb-1 flex items-center gap-2",
                    isRight ? "justify-end text-emerald-200/70" : "justify-start text-slate-200/70",
                  )}
                >
                  <span className="font-medium" style={{ color: g.color }}>
                    {g.speakerLabel}
                  </span>
                  {g.toolCount > 0 ? (
                    <span className="text-[10px] opacity-60">Tools used: {g.toolCount}</span>
                  ) : null}
                  <span className="opacity-70">{statusIcon}</span>
                </div>

                <div
                  className={cn(
                    "rounded-2xl px-3 py-2 text-xs whitespace-pre-wrap break-words border",
                    isRight
                      ? "bg-emerald-500/10 border-emerald-500/20 text-slate-100"
                      : "bg-[#1a1a1a] border-white/10 text-slate-200",
                  )}
                  style={{
                    borderLeft: !isRight ? `3px solid ${g.color}55` : undefined,
                    borderRight: isRight ? `3px solid ${g.color}55` : undefined,
                  }}
                >
                  {g.last.map((b) => b.text).join("\n\n")}
                </div>
              </div>

              {isRight ? (
                <PixelAvatar id={g.speakerId} color={g.color} status={g.status} />
              ) : null}
            </>
          );

          return g.counselMembers && g.counselMembers.length > 0 ? (
            <div
              key={g.speakerId}
              className={cn("flex flex-col gap-1 rounded-lg border border-white/10 bg-black/20 p-2")}
            >
              <button
                type="button"
                className="text-left cursor-pointer text-[11px] text-slate-300 flex items-center gap-2 rounded px-0.5 py-0.5 hover:bg-white/5"
                onClick={() => {
                  const id = g.speakerId;
                  setCounselExpandedById((prev) => ({
                    ...prev,
                    [id]: prev[id] !== true,
                  }));
                }}
              >
                <span className="font-medium text-violet-300">{g.speakerLabel}</span>
                <span className="text-[10px] opacity-60">
                  {counselExpandedById[g.speakerId] === true ? "collapse" : "expand"}
                </span>
              </button>
              {counselExpandedById[g.speakerId] === true ? (
                <div className="mt-1 flex flex-col gap-2">
                  {[...g.counselMembers]
                    .sort((a, b) => a.timestamp - b.timestamp)
                    .map((b) => laneThoughtBubbleRow(b))}
                </div>
              ) : null}
            </div>
          ) : g.parallelMembers && g.parallelMembers.length > 0 ? (
            <details
              key={`parallel-${g.latestTs}-${g.speakerId}`}
              className={cn("flex flex-col gap-1 rounded-lg border border-white/10 bg-black/20 p-2")}
            >
              <summary className="cursor-pointer text-[11px] text-slate-300 list-none flex items-center gap-2">
                <span className="font-medium text-violet-300">{g.speakerLabel}</span>
                <span className="text-[10px] opacity-60">(expand)</span>
              </summary>
              <div className="mt-1 flex flex-col gap-2">
                {[...g.parallelMembers]
                  .sort((a, b) => a.timestamp - b.timestamp)
                  .map((b) => laneThoughtBubbleRow(b))}
              </div>
            </details>
          ) : (
            <div
              key={`${g.speakerId}-${g.latestTs}`}
              className={cn("flex items-end gap-2", isRight ? "justify-end" : "justify-start")}
            >
              {rowInner}
            </div>
          );
        })}
      </div>
    </div>
  );
}
 
