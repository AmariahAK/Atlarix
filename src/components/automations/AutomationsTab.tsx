/**
 * Automations tab (right panel): definition list + triage feed.
 * Codex-app model — unread runs badge, expand-to-read (marks read),
 * auto-archived nothing-to-report runs behind a filter, transcript peek,
 * runs.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  AlarmClock,
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  MessageSquarePlus,
  Pencil,
  Play,
  Plus,
  ScrollText,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { attachmentsAtom } from "@/atoms/chatAtoms";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { IpcClient } from "@/ipc/ipc_client";
import {
  automationRunsAtom,
  automationsAtom,
  automationsFocusRunIdAtom,
  type AutomationListItem,
} from "@/atoms/automationAtoms";
import type {
  AutomationRunView,
  AutomationTrigger,
} from "@/lib/automations/types";
import { AutomationForm } from "./AutomationForm";
import { describeCron } from "@/lib/automations/cron-time";

function triggerLabel(trigger: unknown): string {
  const t = trigger as AutomationTrigger | null;
  if (!t || typeof t !== "object") return "unknown trigger";
  if (t.kind === "schedule") return describeCron(t.cron) ?? `cron ${t.cron}`;
  return `MCP ${t.tool} every ${t.intervalMinutes}m`;
}

function statusBadge(run: AutomationRunView) {
  if (run.status === "running") {
    return (
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-500">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
        running
      </span>
    );
  }
  if (run.status === "error") {
    return (
      <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-red-500/10 text-red-500">
        <CircleAlert className="h-3 w-3" /> error
      </span>
    );
  }
  if (run.status === "nothing-to-report") {
    return (
      <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">
        nothing to report
      </span>
    );
  }
  // "ok" means the run finished WITH something to report: a green ✓ ok read as
  // "all fine" beside "npm test failed" (QA #12). The row's summary says what.
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-foreground/80">
      <CheckCircle2 className="h-3 w-3" /> done
    </span>
  );
}

/** A run's finding in one line, as the CLI and editor show it. */
function runHeadline(run: AutomationRunView): string | null {
  const text = run.error ? `Error: ${run.error}` : run.summary;
  const first = text?.split("\n")[0]?.replace(/`/g, "").trim();
  return first || null;
}

function relativeTime(ts: number): string {
  const delta = Date.now() - ts;
  const min = Math.round(delta / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function AutomationsTab({ appId }: { appId: number | null }) {
  const [automationsList, setAutomations] = useAtom(automationsAtom);
  const [runs, setRuns] = useAtom(automationRunsAtom);
  const [focusRunId, setFocusRunId] = useAtom(automationsFocusRunIdAtom);
  const setRunsAtom = useSetAtom(automationRunsAtom);
  const [showArchived, setShowArchived] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AutomationListItem | null>(null);
  const [mcpServers, setMcpServers] = useState<
    Array<{ id: number; name: string }>
  >([]);
  const [transcript, setTranscript] = useState<{
    title: string;
    messages: Array<{ role: string; content: string }>;
  } | null>(null);
  const setComposerAttachments = useSetAtom(attachmentsAtom);

  // Present a fired event to the model on the user's terms: attach its context
  // to the composer as a standard text chip — the model only reads it when the
  // user sends, and acts under the current session's normal permission flow.
  const sendEventToChat = (run: AutomationRunView) => {
    if (!run.triggerContext) return;
    setComposerAttachments((prev) => [
      ...prev,
      {
        type: "chat-context",
        id: `automation-${run.id}`,
        textPaste: {
          content: `Automation "${run.automationName}" fired:\n${run.triggerContext}`,
          displayName: `automation: ${run.automationName}`,
        },
      },
    ]);
    toast.success(`Added "${run.automationName}" event to chat`);
    if (run.unread) {
      void IpcClient.getInstance().markAutomationRunsRead([run.id]);
      setRunsAtom((prev) =>
        prev.map((r) => (r.id === run.id ? { ...r, unread: false } : r)),
      );
    }
  };

  const refresh = useCallback(async () => {
    if (appId == null) return;
    try {
      const [list, runList] = await Promise.all([
        IpcClient.getInstance().listAutomations(appId),
        IpcClient.getInstance().listAutomationRuns(appId, true),
      ]);
      setAutomations(list.automations);
      setRuns(runList);
    } catch (e) {
      console.error("Failed to load automations:", e);
    }
  }, [appId, setAutomations, setRuns]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A definition changed somewhere else — most often the AGENT creating one via
  // the `automations` tool, which writes in main. Without this the panel only
  // caught up when something else made it refetch.
  useEffect(() => {
    return IpcClient.getInstance().onAutomationsChanged(() => {
      void refresh();
    });
  }, [refresh]);

  // Environment probe for the form (MCP servers).
  useEffect(() => {
    if (appId == null) return;
    IpcClient.getInstance()
      .listMcpServers()
      .then((servers: Array<{ id: number; name: string }>) =>
        setMcpServers(servers.map((s) => ({ id: s.id, name: s.name }))),
      )
      .catch(() => setMcpServers([]));
  }, [appId]);

  // Live feed updates + toast while focused.
  useEffect(() => {
    const unsubscribe = IpcClient.getInstance().onAutomationRunUpdate(
      (view) => {
        setRunsAtom((prev) => {
          const idx = prev.findIndex((r) => r.id === view.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = view;
            return next;
          }
          return [view, ...prev];
        });
        if (view.status !== "running" && view.status !== "nothing-to-report") {
          toast(view.automationName, {
            description:
              view.status === "error"
                ? `Run failed: ${view.error ?? "unknown error"}`
                : (view.summary ?? "Finished with findings"),
          });
        }
      },
    );
    return unsubscribe;
  }, [setRunsAtom]);

  // OS-notification click → highlight the run.
  useEffect(() => {
    if (!focusRunId) return;
    setExpanded((prev) => new Set(prev).add(focusRunId));
    setFocusRunId(null);
  }, [focusRunId, setFocusRunId]);

  const visibleRuns = useMemo(
    () => runs.filter((r) => (showArchived ? true : !r.archived)),
    [runs, showArchived],
  );

  const toggleExpanded = (run: AutomationRunView) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(run.id)) next.delete(run.id);
      else next.add(run.id);
      return next;
    });
    if (run.unread) {
      void IpcClient.getInstance().markAutomationRunsRead([run.id]);
      setRunsAtom((prev) =>
        prev.map((r) => (r.id === run.id ? { ...r, unread: false } : r)),
      );
    }
  };

  const openTranscript = async (run: AutomationRunView) => {
    if (!run.sessionId) return;
    try {
      const { session, messages } =
        await IpcClient.getInstance().getWorkspaceSession(run.sessionId);
      setTranscript({
        title: session.title,
        messages: (messages as Array<{ role: string; content: string }>).map(
          (m) => ({
            role: m.role,
            content: m.content,
          }),
        ),
      });
    } catch (e) {
      toast.error(
        `Could not load transcript: ${e instanceof Error ? e.message : e}`,
      );
    }
  };

  if (appId == null) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-4 text-muted-foreground">
        <AlarmClock className="mb-3 h-12 w-12 opacity-50" />
        <p className="text-sm">Open a workspace to use automations</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      {/* Definitions */}
      <div className="border-b border-border p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Automations
          </h3>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> New
          </Button>
        </div>
        {automationsList.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            Recurring agent runs on a schedule or trigger — a nightly test
            audit, a ping when a PR opens, a Slack watch via MCP. Results land
            in the feed below and ping you when there's something to see.
          </p>
        ) : (
          <div className="space-y-1.5">
            {automationsList.map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2 py-1.5"
              >
                <div className="min-w-0">
                  <p
                    className={cn(
                      "truncate text-sm font-medium",
                      !a.enabled && "opacity-50",
                    )}
                  >
                    {a.name}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {triggerLabel(a.trigger)}
                    {a.lastRunAt
                      ? ` · last run ${relativeTime(a.lastRunAt)}`
                      : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    title="Run now"
                    onClick={() =>
                      void IpcClient.getInstance().runAutomationNow(a.id)
                    }
                  >
                    <Play className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    title="Edit"
                    onClick={() => {
                      setEditing(a);
                      setFormOpen(true);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    title="Delete"
                    onClick={async () => {
                      await IpcClient.getInstance().deleteAutomation(a.id);
                      void refresh();
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                  <Switch
                    checked={a.enabled}
                    onCheckedChange={async (enabled) => {
                      await IpcClient.getInstance().toggleAutomation(
                        a.id,
                        enabled,
                      );
                      void refresh();
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Triage feed */}
      <div className="flex-1 p-3">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Feed
          </h3>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
        </div>
        {visibleRuns.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            {/* Runs that were archived (nothing to report) are runs: "No runs
                yet" beside "last run 1m ago" read as a contradiction (QA #22). */}
            {runs.length > 0
              ? "No new runs."
              : automationsList.length === 0
                ? "No runs yet — create an automation above."
                : "No runs yet."}
          </p>
        ) : (
          <div className="space-y-1.5">
            {visibleRuns.map((run) => {
              const isOpen = expanded.has(run.id);
              return (
                <div
                  key={run.id}
                  className={cn(
                    "rounded-md border px-2 py-1.5",
                    run.unread
                      ? "border-primary/40 bg-primary/5"
                      : "border-border/60",
                  )}
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 text-left"
                    onClick={() => toggleExpanded(run)}
                  >
                    {isOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )}
                    {run.unread && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {run.automationName}
                      {!isOpen && runHeadline(run) && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {runHeadline(run)}
                        </span>
                      )}
                    </span>
                    {statusBadge(run)}
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {relativeTime(run.startedAt)}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="mt-2 space-y-2 pl-5">
                      {(run.summary || run.error) && (
                        <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                          {run.error ? `Error: ${run.error}` : run.summary}
                        </p>
                      )}
                      {run.triggerContext && (
                        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
                          {run.triggerContext}
                        </pre>
                      )}
                      <div className="flex flex-wrap items-center gap-1.5">
                        {run.triggerContext && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[11px]"
                            onClick={() => sendEventToChat(run)}
                          >
                            <MessageSquarePlus className="mr-1 h-3 w-3" /> Send
                            to chat
                          </Button>
                        )}
                        {run.sessionId && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[11px]"
                            onClick={() => void openTranscript(run)}
                          >
                            <ScrollText className="mr-1 h-3 w-3" /> Transcript
                          </Button>
                        )}
                        {!run.archived && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[11px]"
                            onClick={async () => {
                              await IpcClient.getInstance().archiveAutomationRun(
                                run.id,
                              );
                              setRunsAtom((prev) =>
                                prev.map((r) =>
                                  r.id === run.id
                                    ? { ...r, archived: true, unread: false }
                                    : r,
                                ),
                              );
                            }}
                          >
                            <Archive className="mr-1 h-3 w-3" /> Archive
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {formOpen && (
        <AutomationForm
          workspaceId={appId}
          existing={editing}
          mcpServers={mcpServers}
          open={formOpen}
          onClose={() => setFormOpen(false)}
          onSaved={() => void refresh()}
        />
      )}

      {/* Transcript peek (read-only — automation transcripts live outside the chat list) */}
      <Dialog
        open={transcript != null}
        onOpenChange={(v) => !v && setTranscript(null)}
      >
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-auto">
          <DialogHeader>
            <DialogTitle>{transcript?.title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {transcript?.messages.map((m, i) => (
              <div key={i} className="text-sm">
                <p className="mb-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                  {m.role}
                </p>
                <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-xs">
                  {m.content}
                </pre>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
