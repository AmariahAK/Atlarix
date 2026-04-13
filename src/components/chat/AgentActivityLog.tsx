import React, { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ActivityStreamItem } from "@/atoms/sourceAtoms";

export type ActivityLogRow =
  | {
      kind: "task_step";
      content: string;
      done: boolean;
      timestamp: number;
    }
  | { kind: "files_explored"; count: number; timestamp: number }
  | { kind: "searches_run"; count: number; timestamp: number }
  | {
      kind: "terminal_run";
      content: string;
      detail: string;
      timestamp: number;
    }
  | { kind: "context_summarized"; timestamp: number }
  | {
      kind: "delegation";
      content: string;
      done: boolean;
      timestamp: number;
    }
  | { kind: "counsel_start"; content: string; timestamp: number }
  | { kind: "plan_created"; stepCount: number; content: string; timestamp: number }
  | { kind: "line"; content: string; timestamp: number };

function stableSort(items: ActivityStreamItem[]) {
  return [...items].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

function classifyToolUse(item: ActivityStreamItem): "search" | "file" | "terminal" | "other" {
  const s = `${item.detail ?? ""} ${item.label ?? ""}`.toLowerCase();
  if (s.includes("run_command") || s.includes("run command") || /^\$/.test(item.detail?.trim() ?? "")) {
    return "terminal";
  }
  if (
    s.includes("search_code") ||
    s.includes("semantic") ||
    s.includes("deep_search") ||
    s.includes("web_search")
  ) {
    return "search";
  }
  if (
    s.includes("read_file") ||
    s.includes("write_file") ||
    s.includes("explore_folder") ||
    s.includes("list_files") ||
    s.includes("find_file")
  ) {
    return "file";
  }
  return "other";
}

/** Map activity stream items to condensed rows (aggregated searches/files). */
export function buildActivityLogRows(items: ActivityStreamItem[]): ActivityLogRow[] {
  const sorted = stableSort(items);
  const rows: ActivityLogRow[] = [];
  let searchRun = 0;
  let fileRun = 0;
  let lastSearchTs = 0;
  let lastFileTs = 0;

  const flushSearch = () => {
    if (searchRun > 0) {
      rows.push({
        kind: "searches_run",
        count: searchRun,
        timestamp: lastSearchTs,
      });
      searchRun = 0;
    }
  };
  const flushFiles = () => {
    if (fileRun > 0) {
      rows.push({
        kind: "files_explored",
        count: fileRun,
        timestamp: lastFileTs,
      });
      fileRun = 0;
    }
  };

  for (const it of sorted) {
    switch (it.type) {
      case "delegation_start": {
        flushSearch();
        flushFiles();
        const agentLabel = it.agent
          ? it.agent.charAt(0).toUpperCase() + it.agent.slice(1)
          : "agent";
        rows.push({
          kind: "delegation",
          content: `Delegating to ${agentLabel}…`,
          done: false,
          timestamp: it.timestamp,
        });
        break;
      }
      case "delegation_complete":
      case "delegation_error": {
        flushSearch();
        flushFiles();
        rows.push({
          kind: "delegation",
          content:
            it.type === "delegation_error"
              ? `${it.agent ?? "Agent"} failed`
              : `${it.agent ? it.agent.charAt(0).toUpperCase() + it.agent.slice(1) : "Agent"} completed`,
          done: it.type === "delegation_complete",
          timestamp: it.timestamp,
        });
        break;
      }
      case "counsel_start": {
        flushSearch();
        flushFiles();
        const n = it.participantCount ?? 3;
        rows.push({
          kind: "counsel_start",
          content: `Counsel — ${n} perspectives running…`,
          timestamp: it.timestamp,
        });
        break;
      }
      case "counsel_participant_complete": {
        flushSearch();
        flushFiles();
        const role = it.counselRole ? it.counselRole.charAt(0).toUpperCase() + it.counselRole.slice(1) : "Participant";
        const prev = it.preview?.trim();
        rows.push({
          kind: "line",
          content: prev
            ? `${role}: ${prev.length > 80 ? `${prev.slice(0, 80)}…` : prev}`
            : `${role} complete`,
          timestamp: it.timestamp,
        });
        break;
      }
      case "counsel_synthesising": {
        flushSearch();
        flushFiles();
        rows.push({
          kind: "line",
          content: "Synthesising perspectives…",
          timestamp: it.timestamp,
        });
        break;
      }
      case "counsel_complete": {
        flushSearch();
        flushFiles();
        const len = it.synthesisLength;
        rows.push({
          kind: "line",
          content:
            typeof len === "number" && len > 0
              ? `Counsel complete — ${len.toLocaleString()} characters`
              : "Counsel complete",
          timestamp: it.timestamp,
        });
        break;
      }
      case "plan_created": {
        flushSearch();
        flushFiles();
        const m = /^Plan created — (\d+) steps$/.exec(it.label ?? "");
        const n =
          typeof it.stepCount === "number"
            ? it.stepCount
            : m
              ? parseInt(m[1]!, 10)
              : 0;
        rows.push({
          kind: "plan_created",
          stepCount: n,
          content: it.task ?? it.detail ?? "",
          timestamp: it.timestamp,
        });
        break;
      }
      case "background": {
        if (/summariz/i.test(it.label)) {
          flushSearch();
          flushFiles();
          if (it.status === "done") {
            rows.push({
              kind: "context_summarized",
              timestamp: it.timestamp,
            });
          }
        }
        break;
      }
      case "parallel_prefetch_start": {
        flushSearch();
        flushFiles();
        rows.push({
          kind: "line",
          content: it.label?.trim() || "Research + planning (parallel)…",
          timestamp: it.timestamp,
        });
        break;
      }
      case "parallel_prefetch_complete": {
        flushSearch();
        flushFiles();
        const detail = it.detail?.trim() || it.label?.trim() || "Prefetch complete";
        rows.push({
          kind: "line",
          content: detail,
          timestamp: it.timestamp,
        });
        break;
      }
      case "duration_limit_reached": {
        flushSearch();
        flushFiles();
        const head = it.label?.trim() || "Task paused after 30 minutes";
        const tail = it.detail?.trim();
        rows.push({
          kind: "line",
          content: tail ? `${head} — ${tail}` : head,
          timestamp: it.timestamp,
        });
        break;
      }
      case "loop_detected":
      case "loop_repetition_aborted": {
        flushSearch();
        flushFiles();
        const head = it.label?.trim() || (it.type === "loop_detected" ? "Repeated action" : "Task stopped");
        const tail = it.detail?.trim();
        rows.push({
          kind: "line",
          content: tail ? `${head} — ${tail}` : head,
          timestamp: it.timestamp,
        });
        break;
      }
      case "tool_use": {
        const kind = classifyToolUse(it);
        if (kind === "search") {
          flushFiles();
          searchRun += 1;
          lastSearchTs = it.timestamp;
        } else if (kind === "file") {
          flushSearch();
          fileRun += 1;
          lastFileTs = it.timestamp;
        } else if (kind === "terminal") {
          flushSearch();
          flushFiles();
          const cmd =
            it.detail?.split("\n")[0]?.trim() ||
            it.label?.trim() ||
            "Running command…";
          rows.push({
            kind: "terminal_run",
            content: cmd,
            detail: it.detail?.trim() ?? "",
            timestamp: it.timestamp,
          });
        } else {
          flushSearch();
          flushFiles();
          const line = it.detail?.trim() || it.label?.trim();
          if (line) {
            rows.push({
              kind: "line",
              content: line,
              timestamp: it.timestamp,
            });
          }
        }
        break;
      }
      default:
        flushSearch();
        flushFiles();
        break;
    }
  }
  flushSearch();
  flushFiles();
  return rows;
}

interface AgentActivityLogProps {
  items: ActivityStreamItem[];
  isStreaming: boolean;
  /** When false and not user-expanded, show one-line summary */
  defaultCollapsed?: boolean;
  className?: string;
}

export function AgentActivityLog({
  items,
  isStreaming,
  defaultCollapsed = true,
  className,
}: AgentActivityLogProps) {
  const rows = useMemo(() => buildActivityLogRows(items), [items]);
  const [userExpanded, setUserExpanded] = useState(false);

  const collapsed = !isStreaming && defaultCollapsed && !userExpanded;

  if (rows.length === 0) return null;

  if (collapsed) {
    return (
      <div className={cn("mb-2 text-xs text-muted-foreground", className)}>
        <button
          type="button"
          onClick={() => setUserExpanded(true)}
          className="flex items-center gap-1 hover:text-foreground transition-colors"
        >
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          <span>
            {rows.length} activit{rows.length === 1 ? "y" : "ies"} · Show
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "mb-2 rounded-md border border-border/40 bg-muted/20 px-2.5 py-2 text-xs space-y-1.5",
        className,
      )}
    >
      {!isStreaming && defaultCollapsed && (
        <button
          type="button"
          onClick={() => setUserExpanded(false)}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground mb-1"
        >
          <ChevronDown className="h-3.5 w-3.5" />
          Hide activity
        </button>
      )}
      {rows.map((row, i) => (
        <ActivityLogRowView key={`${row.kind}-${row.timestamp}-${i}`} row={row} />
      ))}
    </div>
  );
}

function ActivityLogRowView({ row }: { row: ActivityLogRow }) {
  const [open, setOpen] = useState(false);

  switch (row.kind) {
    case "task_step":
      return (
        <div className="flex items-start gap-2 text-muted-foreground">
          {row.done ? (
            <span className="text-emerald-500 shrink-0">✓</span>
          ) : (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-500/90" />
          )}
          <span>{row.content}</span>
        </div>
      );
    case "files_explored":
      return (
        <div className="text-muted-foreground pl-6">
          Explored {row.count} file{row.count === 1 ? "" : "s"}
        </div>
      );
    case "searches_run":
      return (
        <div className="text-muted-foreground pl-6">
          Explored {row.count} search{row.count === 1 ? "" : "es"}
        </div>
      );
    case "context_summarized":
      return (
        <div className="text-muted-foreground pl-6">Chat context summarized.</div>
      );
    case "delegation":
      return (
        <div className="flex items-start gap-2 text-muted-foreground">
          {row.done ? (
            <span className="text-emerald-500 shrink-0">✓</span>
          ) : (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-500/90" />
          )}
          <span>{row.content}</span>
        </div>
      );
    case "counsel_start":
      return <div className="text-muted-foreground pl-1">{row.content}</div>;
    case "plan_created":
      return (
        <div className="flex items-start gap-2 text-muted-foreground">
          <span className="text-emerald-500 shrink-0" aria-hidden>
            📋
          </span>
          <div className="min-w-0">
            <div className="text-foreground/90 text-[11px] font-medium">
              Plan created — {row.stepCount} steps
            </div>
            {row.content ? (
              <div className="text-[10px] text-muted-foreground line-clamp-2 mt-0.5">{row.content}</div>
            ) : null}
          </div>
        </div>
      );
    case "terminal_run":
      return (
        <div className="border border-border/30 rounded bg-background/40 overflow-hidden">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="w-full flex items-center gap-1.5 px-2 py-1 text-left text-muted-foreground hover:bg-muted/40"
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="font-mono truncate text-[11px]">{row.content}</span>
          </button>
          {open && row.detail ? (
            <pre className="max-h-40 overflow-y-auto px-2 pb-2 pt-0 text-[10px] text-muted-foreground whitespace-pre-wrap break-all border-t border-border/20">
              {row.detail}
            </pre>
          ) : null}
        </div>
      );
    case "line":
      return <div className="text-muted-foreground pl-1">{row.content}</div>;
    default:
      return null;
  }
}
