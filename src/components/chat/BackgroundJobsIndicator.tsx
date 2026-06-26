import { useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Loader2, MessageSquarePlus, X } from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";
import { backgroundJobsByChatIdAtom } from "@/atoms/sourceAtoms";
import { attachmentsAtom } from "@/atoms/chatAtoms";
import { showSuccess } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * "N background tasks running" chip shown while the agent has detached commands
 * in flight — visible even when no turn is streaming, so you can keep chatting
 * and cancel a job. The agent is auto-woken when a job finishes.
 *
 * Mirrors the folded-attachments UX: instead of a flat row of per-job chips
 * (which overflows once there are a few), the jobs fold into ONE summary card;
 * clicking it opens a scrollable popover listing each task with its send-to-chat
 * and cancel actions. (Sub-agents keep their own in-message cards — this is the
 * background-task surface only, deliberately NOT a combined one.)
 */
export function BackgroundJobsIndicator({
  chatId,
}: {
  chatId: number | null | undefined;
}) {
  const byChat = useAtomValue(backgroundJobsByChatIdAtom);
  const setAttachments = useSetAtom(attachmentsAtom);
  const [open, setOpen] = useState(false);
  const jobs = chatId != null ? byChat[chatId] : undefined;
  if (!jobs || jobs.length === 0) return null;

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
            title={`${jobs.length} background task${jobs.length === 1 ? "" : "s"} running — click to view or cancel`}
          >
            <Loader2 className="h-3 w-3 animate-spin text-amber-600 dark:text-amber-500" />
            <span className="font-medium">
              {jobs.length} background task{jobs.length === 1 ? "" : "s"} running
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-[26rem] max-w-[calc(100vw-2rem)] p-2"
        >
          <div className="mb-2 px-1 text-xs font-semibold text-muted-foreground">
            Background tasks ({jobs.length})
          </div>
          <ScrollArea className="max-h-72">
            <div className="flex w-full flex-col items-stretch gap-1 pr-2">
              {jobs.map((j) => (
                <div
                  key={j.operationId}
                  className="flex w-full min-w-0 items-center gap-1 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5"
                >
                  {/* min-w-0 is required for `truncate` to clip a flex child. */}
                  <code
                    className="min-w-0 flex-1 truncate font-mono text-[11px] opacity-80"
                    title={j.command}
                  >
                    {j.command}
                  </code>
                  <button
                    type="button"
                    onClick={() => void sendJobToChat(j.operationId, j.command)}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    title="Send this task (with its output) to chat"
                  >
                    <MessageSquarePlus className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => cancelJob(j.operationId)}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                    title="Cancel this background task"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
    </div>
  );
}
