/**
 * Right-panel Activity feed — live agent actions from chat:activity stream.
 */

import { useMemo, useRef, useEffect } from "react";
import { useAtomValue } from "jotai";
import {
  activityStreamItemsAtom,
  type ActivityStreamItem,
} from "@/atoms/sourceAtoms";
import { selectedChatIdAtom } from "@/atoms/chatAtoms";
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

function statusSuffix(item: ActivityStreamItem): string {
  if (item.status === "running" || item.status === "active") {
    return "output streaming...";
  }
  if (item.status === "error") {
    return "failed";
  }
  if (item.status === "done") {
    if (item.duration != null) {
      return `completed (${(item.duration / 1000).toFixed(0)}s)`;
    }
    return "completed";
  }
  return "";
}

function ActivityRow({ item }: { item: ActivityStreamItem }) {
  const Icon = iconForItem(item);
  const suffix = statusSuffix(item);
  const isRunning = item.status === "running" || item.status === "active";

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
        <div className="text-foreground">
          <span className="text-muted-foreground">{item.label}</span>
          {item.detail ? (
            <span className={cn("ml-1", isRunning && "text-blue-400/90")}>
              {item.detail.length > 120
                ? `${item.detail.slice(0, 117)}...`
                : item.detail}
            </span>
          ) : null}
        </div>
        {suffix ? (
          <div className="text-muted-foreground mt-0.5">
            {isRunning ? `↳ ${suffix}` : suffix}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ActivityPanel() {
  const items = useAtomValue(activityStreamItemsAtom);
  const chatId = useAtomValue(selectedChatIdAtom);
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
