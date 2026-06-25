import { useAtomValue, useSetAtom } from "jotai";
import { Loader2, MessageSquarePlus, X } from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";
import { backgroundJobsByChatIdAtom } from "@/atoms/sourceAtoms";
import { attachmentsAtom } from "@/atoms/chatAtoms";
import { showSuccess } from "@/lib/toast";

/**
 * "N background jobs running" chip shown while the agent has detached
 * commands in flight — visible even when no turn is streaming, so you can keep
 * chatting and cancel a job. The agent is auto-woken when a job finishes.
 */
export function BackgroundJobsIndicator({
  chatId,
}: {
  chatId: number | null | undefined;
}) {
  const byChat = useAtomValue(backgroundJobsByChatIdAtom);
  const setAttachments = useSetAtom(attachmentsAtom);
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

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1">
        <Loader2 className="h-3 w-3 animate-spin text-amber-600 dark:text-amber-500" />
        <span className="font-medium">
          {jobs.length} background job{jobs.length === 1 ? "" : "s"} running
        </span>
      </span>
      {jobs.map((j) => (
        <span
          key={j.operationId}
          className="flex items-center gap-1 rounded-full border border-border bg-muted/30 px-2 py-1"
          title={j.command}
        >
          <code className="max-w-[200px] truncate font-mono text-[10px] opacity-80">
            {j.command}
          </code>
          <button
            type="button"
            onClick={() => void sendJobToChat(j.operationId, j.command)}
            className="rounded-full p-0.5 hover:bg-muted hover:text-foreground"
            title="Send this job (with its output) to chat"
          >
            <MessageSquarePlus className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => {
              if (chatId != null) {
                void IpcClient.getInstance().backgroundJobCancel(chatId, j.operationId);
              }
            }}
            className="rounded-full p-0.5 hover:bg-muted hover:text-foreground"
            title="Cancel this background command"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
