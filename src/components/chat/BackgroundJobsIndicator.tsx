import { useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  Loader2,
  MessageSquarePlus,
  X,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";
import {
  backgroundJobsByChatIdAtom,
  subagentJobsByChatIdAtom,
  type BackgroundJobView,
  type SubagentJobView,
} from "@/atoms/sourceAtoms";
import { attachmentsAtom } from "@/atoms/chatAtoms";
import { showSuccess } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { toolBodyText } from "./stream-item-styles";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * "N background tasks running" chip shown while the agent has detached commands
 * in flight — visible even when no turn is streaming, so you can keep chatting
 * and cancel a job. The agent is auto-woken when a job finishes.
 *
 * Each job folds into ONE summary card; the popover lists every task and lets you
 * EXPAND a task to watch its live output tail (polled while open), see a
 * stalled/matched badge, send it to chat to ask about it, or cancel it.
 *
 * v14.21: SUB-AGENTS appear here too, in their own section. They used to be
 * invisible to this surface — the renderer skipped their update events
 * entirely — so a running sub-agent could not be seen or stopped from the UI at
 * all, only from inside the model's own turn. Their in-message cards still
 * exist; those are the narration, this is the control.
 */
export function BackgroundJobsIndicator({
  chatId,
}: {
  chatId: number | null | undefined;
}) {
  const byChat = useAtomValue(backgroundJobsByChatIdAtom);
  const subsByChat = useAtomValue(subagentJobsByChatIdAtom);
  const setAttachments = useSetAtom(attachmentsAtom);
  const [open, setOpen] = useState(false);
  const jobs = (chatId != null ? byChat[chatId] : undefined) ?? [];
  const subagents = (chatId != null ? subsByChat[chatId] : undefined) ?? [];
  const total = jobs.length + subagents.length;
  if (total === 0) return null;

  // C3: send a running job to chat as an `id-<jobId>` chip (with its output
  // tail) so the user can ask the model about it ("this looks stuck").
  const sendJobToChat = async (operationId: string, command: string) => {
    if (chatId == null) return;
    const detail = await IpcClient.getInstance()
      .backgroundJobOutput(chatId, operationId)
      .catch(() => null);
    setAttachments((prev) => [
      ...prev,
      {
        type: "chat-context",
        id: `job-${operationId}-${Date.now()}`,
        backgroundJob: {
          jobId: operationId,
          command: detail?.command ?? command,
          outputTail: detail?.output ?? "",
        },
      },
    ]);
    showSuccess(`Added id-${operationId} to chat`);
  };

  const cancelJob = (operationId: string) => {
    if (chatId != null) {
      void IpcClient.getInstance().backgroundJobCancel(chatId, operationId);
    }
  };

  const cancelSubagent = (taskId: string) => {
    if (chatId != null) {
      void IpcClient.getInstance().subagentJobCancel(chatId, taskId);
    }
  };

  return (
    <div className="mt-1.5 flex items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1",
              "text-xs text-muted-foreground cursor-pointer hover:bg-muted/60 transition-colors",
            )}
            title={`${total} background task${total === 1 ? "" : "s"} running — click to view or cancel`}
          >
            <Loader2 className="h-3 w-3 animate-spin text-amber-600 dark:text-amber-500" />
            <span className="font-medium">
              {total} background task{total === 1 ? "" : "s"} running
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-[26rem] max-w-[calc(100vw-2rem)] p-2"
        >
          {/* Plain overflow div (NOT Radix ScrollArea — its table-layout
              viewport lets rows grow past the width, clipping the buttons). */}
          <div className="flex max-h-80 w-full flex-col items-stretch gap-1 overflow-y-auto pr-1">
            {jobs.length > 0 ? (
              <>
                <div className="px-1 pb-0.5 text-xs font-semibold text-muted-foreground">
                  Commands ({jobs.length})
                </div>
                {jobs.map((j) => (
                  <BackgroundJobRow
                    key={j.operationId}
                    job={j}
                    chatId={chatId ?? null}
                    popoverOpen={open}
                    onSendToChat={sendJobToChat}
                    onCancel={cancelJob}
                  />
                ))}
              </>
            ) : null}
            {subagents.length > 0 ? (
              <>
                <div className="px-1 pt-1 pb-0.5 text-xs font-semibold text-muted-foreground">
                  Sub-agents ({subagents.length})
                </div>
                {subagents.map((sa) => (
                  <SubagentRow
                    key={sa.taskId}
                    subagent={sa}
                    chatId={chatId ?? null}
                    popoverOpen={open}
                    onCancel={cancelSubagent}
                  />
                ))}
              </>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * One background-job row. Collapsed: command + status badge + actions. Expanded:
 * polls the live output tail (only while the popover is open) and auto-scrolls,
 * so you can watch progress and then discuss it.
 */
function BackgroundJobRow({
  job,
  chatId,
  popoverOpen,
  onSendToChat,
  onCancel,
}: {
  job: BackgroundJobView;
  chatId: number | null;
  popoverOpen: boolean;
  onSendToChat: (operationId: string, command: string) => void;
  onCancel: (operationId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [output, setOutput] = useState<string>("");
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Pull the live output tail on expand + poll while open+expanded. Pull-based
  // (no push channel for output) — scoped to the open, expanded row only.
  useEffect(() => {
    if (!expanded || !popoverOpen || chatId == null) return;
    let cancelled = false;
    const pull = () => {
      void IpcClient.getInstance()
        .backgroundJobOutput(chatId, job.operationId)
        .then((d) => {
          if (!cancelled && d) setOutput(d.output);
        })
        .catch(() => {});
    };
    pull();
    const t = setInterval(pull, 1500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [expanded, popoverOpen, chatId, job.operationId]);

  // Auto-scroll the output to the bottom as it grows.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output, expanded]);

  return (
    <div className="w-full min-w-0 rounded-md border border-border/60 bg-muted/30">
      <div className="flex w-full min-w-0 items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={expanded ? "Hide output" : "Show live output"}
          aria-label={expanded ? "Hide output" : "Show live output"}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        {/* min-w-0 is required for `truncate` to clip a flex child. */}
        <code
          className="min-w-0 flex-1 truncate font-mono text-[11px] opacity-80"
          title={job.command}
        >
          {job.command}
        </code>
        {job.wakeMatched ? (
          <span className="shrink-0 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-800 dark:text-emerald-200">
            matched
          </span>
        ) : job.stalled ? (
          <span className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
            stalled
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => onSendToChat(job.operationId, job.command)}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Send this task (with its output) to chat"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => onCancel(job.operationId)}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
          title="Cancel this background task"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {expanded ? (
        <div
          ref={bodyRef}
          className={cn(
            toolBodyText,
            // Bounded + scrollable per job so a chatty task can't overwhelm the
            // popover — the whole list is also capped (max-h-80) above.
            "max-h-40 overflow-y-auto overscroll-contain border-t border-border/60 px-2 py-1.5 font-mono whitespace-pre-wrap break-all",
          )}
        >
          {output || "(no output yet)"}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One sub-agent row. Same shape as a background-command row, minus "send to
 * chat" — a sub-agent's findings already come back to the model on their own,
 * so attaching its narration would just duplicate what it is about to say.
 *
 * The output pull is a TAIL, deliberately: the model has its own incremental
 * cursor into this buffer, and a human opening a disclosure triangle must not
 * consume it.
 */
function SubagentRow({
  subagent,
  chatId,
  popoverOpen,
  onCancel,
}: {
  subagent: SubagentJobView;
  chatId: number | null;
  popoverOpen: boolean;
  onCancel: (taskId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [output, setOutput] = useState<string>("");
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!expanded || !popoverOpen || chatId == null) return;
    let cancelled = false;
    const pull = () => {
      void IpcClient.getInstance()
        .subagentJobOutput(chatId, subagent.taskId)
        .then((d) => {
          if (!cancelled && d) setOutput(d.text);
        })
        .catch(() => {});
    };
    pull();
    const t = setInterval(pull, 1500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [expanded, popoverOpen, chatId, subagent.taskId]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output, expanded]);

  return (
    <div className="w-full min-w-0 rounded-md border border-border/60 bg-muted/30">
      <div className="flex w-full min-w-0 items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          title={expanded ? "Hide progress" : "Show live progress"}
          aria-label={expanded ? "Hide progress" : "Show live progress"}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>
        {/* min-w-0 is required for `truncate` to clip a flex child. */}
        <span
          className="min-w-0 flex-1 truncate text-[11px] opacity-80"
          title={subagent.description}
        >
          {subagent.description}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {Math.round(subagent.elapsedMs / 1000)}s
        </span>
        {subagent.stalled ? (
          <span className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
            quiet
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => onCancel(subagent.taskId)}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
          title="Stop this sub-agent"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {expanded ? (
        <div
          ref={bodyRef}
          className={cn(
            toolBodyText,
            "max-h-40 overflow-y-auto overscroll-contain border-t border-border/60 px-2 py-1.5 font-mono whitespace-pre-wrap break-all",
          )}
        >
          {output || (subagent.lastOutput ?? "") || "(no progress yet)"}
        </div>
      ) : null}
    </div>
  );
}
