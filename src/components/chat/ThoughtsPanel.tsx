/**
 * ThoughtsPanel — WhatsApp-style agent group chat.
 *
 * Refactor: ThoughtsPanel
 * - Data source: activityStreamItemsAtom only (renderer-side derivation).
 * - Main (leader) appears on the right; delegated agents on the left.
 */
 
import React, { useMemo } from "react";
import { useAtomValue } from "jotai";
import { activityStreamItemsAtom, type ActivityStreamItem } from "@/atoms/sourceAtoms";
import { cn } from "@/lib/utils";
import { X, Check, AlertTriangle, Loader2 } from "lucide-react";
 
interface ThoughtsPanelProps {
  onClose?: () => void;
}
 
type Side = "left" | "right";
type BubbleStatus = "active" | "done" | "error";
 
type ThoughtBubble = {
  id: string;
  side: Side;
  speakerId: string;
  speakerLabel: string;
  status: BubbleStatus;
  text: string;
  timestamp: number;
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
  if (item.type === "routing_decision" || item.type === "turn_summary" || item.type === "mode_change") {
    return { id: "main", label: "Main", side: "right" };
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
  if (item.status === "error" || item.type === "delegation_error") return "error";
  if (item.status === "done" || item.type === "delegation_complete") return "done";
  return "active";
}
 
function bubbleTextFor(item: ActivityStreamItem): string {
  switch (item.type) {
    case "routing_decision":
      return item.detail?.trim() || item.label?.trim() || "Routing decision";
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
    default:
      return item.detail?.trim() || item.label?.trim() || item.type;
  }
}
 
function stableSort(items: ActivityStreamItem[]) {
  return [...items].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}
 
export function ThoughtsPanel({ onClose }: ThoughtsPanelProps) {
  const items = useAtomValue(activityStreamItemsAtom);
 
  const bubbles: ThoughtBubble[] = useMemo(() => {
    const sorted = stableSort(items);
    const out: ThoughtBubble[] = [];
 
    // Track “agent instances” to generate Research_1 / Architect_2 labels deterministically.
    const countsByAgent = new Map<string, number>();
    const instanceByDelegationId = new Map<string, { speakerId: string; speakerLabel: string }>();
 
    for (const it of sorted) {
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
      });
    }
    return out;
  }, [items]);
 
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
    };
    const bySpeaker = new Map<string, Group>();
    for (const b of bubbles) {
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

      // Tool counting (best-effort): tool_use events currently don't reliably tag agents.
      // We still provide a compact signal; if future events include agent attribution, this grouping will improve naturally.
      if (String(b.text).toLowerCase().includes("tool")) {
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
        <span>Thoughts</span>
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
 
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 bg-muted/10">
        <span className="text-xs font-medium">Thoughts</span>
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
 
      <div className="flex-1 overflow-auto p-3 space-y-3 bg-[#0f0f0f]">
        {grouped.map((g) => {
          const isRight = g.side === "right";
          const statusIcon =
            g.status === "active" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />
            ) : g.status === "done" ? (
              <Check className="h-3.5 w-3.5 text-emerald-500" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5 text-rose-500" />
            );
 
          return (
            <div
              key={g.speakerId}
              className={cn("flex items-end gap-2", isRight ? "justify-end" : "justify-start")}
            >
              {!isRight ? (
                <PixelAvatar id={g.speakerId} color={g.color} status={g.status} />
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
                  <span className="text-[10px] opacity-60">Tools used: {g.toolCount}</span>
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
 
