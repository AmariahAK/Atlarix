/**
 * Right-panel Activity feed — live agent actions from chat:activity stream.
 */

import { useMemo, useRef, useEffect } from "react";
import { useAtomValue } from "jotai";
import {
  activityStreamItemsAtom,
  type ActivityStreamItem,
} from "@/atoms/sourceAtoms";
import { activeChatIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
import {
  Play,
  BookOpen,
  Pencil,
  Search,
  Globe,
  Users,
  Clock,
  Loader2,
  Check,
  X,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function iconForItem(item: ActivityStreamItem): LucideIcon {
  const s = `${item.type} ${item.label ?? ""} ${item.detail ?? ""}`.toLowerCase();
  if (
    item.type === "delegation_start" ||
    item.type === "delegation_complete" ||
    item.type === "delegation_error" ||
    s.includes("agent team")
  ) {
    return Users;
  }
  if (
    s.includes("run_command") ||
    s.includes("terminal") ||
    item.detail?.trim().startsWith("$")
  ) {
    return Play;
  }
  if (
    s.includes("web_search") ||
    s.includes("deep_research") ||
    s.includes("read_url")
  ) {
    return Globe;
  }
  if (s.includes("search") || s.includes("grep") || s.includes("semantic")) {
    return Search;
  }
  if (s.includes("write_file") || s.includes("edit_file") || s.includes("write ")) {
    return Pencil;
  }
  if (s.includes("read_file") || s.includes("explore") || s.includes("list_files")) {
    return BookOpen;
  }
  if (s.includes("permission") || s.includes("approval")) {
    return Clock;
  }
  return Wrench;
}

function inlineStatusLabel(item: ActivityStreamItem): string | null {
  if (item.status === "running" || item.status === "active") return "Running…";
  if (item.status === "error") return "Failed";
  if (item.status === "done") {
    if (item.duration != null) {
      return `Done (${(item.duration / 1000).toFixed(1)}s)`;
    }
    return "Done";
  }
  return null;
}

/** Hide redundant detail echoed in the label (e.g. "Running…" on tool rows). */
function displayDetail(item: ActivityStreamItem): string | undefined {
  const d = item.detail?.trim();
  if (!d) return undefined;
  if (/^running\.{0,3}$/i.test(d)) return undefined;
  if (d === item.label?.trim()) return undefined;
  return d.length > 120 ? `${d.slice(0, 117)}…` : d;
}

function ActivityRow({ item }: { item: ActivityStreamItem }) {
  const Icon = iconForItem(item);
  const isRunning = item.status === "running" || item.status === "active";
  const statusLabel = inlineStatusLabel(item);
  const detail = displayDetail(item);

  return (
    <div className="flex gap-2 py-1.5 text-xs font-mono border-b border-border/40 last:border-0">
      <span className="text-muted-foreground shrink-0 tabular-nums">
        [{formatTime(item.timestamp)}]
      </span>
      <span className="shrink-0 text-muted-foreground flex items-center">
        {isRunning ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : item.status === "error" ? (
          <X className="w-3.5 h-3.5 text-red-400" />
        ) : item.status === "done" ? (
          <Check className="w-3.5 h-3.5 text-emerald-400" />
        ) : (
          <Icon className="w-3.5 h-3.5" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap text-foreground">
          <span className="min-w-0">{item.label}</span>
          {statusLabel ? (
            <span
              className={cn(
                "shrink-0 text-[10px] uppercase tracking-wide",
                isRunning && "text-blue-400/90",
                item.status === "error" && "text-red-400/90",
                item.status === "done" && "text-emerald-400/80",
              )}
            >
              {statusLabel}
            </span>
          ) : null}
        </div>
        {detail ? (
          <div className="text-muted-foreground mt-0.5 line-clamp-2">{detail}</div>
        ) : null}
      </div>
    </div>
  );
}

export function ActivityPanel() {
  const items = useAtomValue(activityStreamItemsAtom);
  const activeChatId = useAtomValue(activeChatIdAtom);
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const chatId = activeChatId ?? selectedChatId;
  const scrollRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const sorted = [...items].sort((a, b) => a.timestamp - b.timestamp);
    if (chatId == null) return sorted;
    return sorted.filter((i) => i.chatId == null || i.chatId === chatId);
  }, [items, chatId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filtered.length, filtered[filtered.length - 1]?.timestamp]);

  if (filtered.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-6 text-center">
        <Wrench className="w-10 h-10 mb-3 opacity-40" />
        <p className="text-sm font-medium">No agent activity yet</p>
        <p className="text-xs mt-1 max-w-[220px]">
          Tool runs, file reads, and commands appear here while the agent works.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <Wrench className="w-4 h-4 text-primary" />
        <span className="text-sm font-medium">Agent activity</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {filtered.length} events
        </span>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2">
        {filtered.map((item) => (
          <ActivityRow key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}
