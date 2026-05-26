import { useCallback, useEffect, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  addOperation,
  getOperationsByStatus,
  permissionQueueAtom,
  removeOperation,
  updateOperationStatus,
  type QueuedOperation,
} from "@/atoms/permissionQueueAtom";
import { IpcClient } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";
import { Shield } from "lucide-react";

function InlinePermissionCard({
  chatId,
  id,
  title,
  detail,
  isDangerous,
  onApprove,
  onReject,
}: {
  chatId: number;
  id: string;
  title: string;
  detail?: string;
  isDangerous?: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <div
      className={`my-1.5 rounded-lg border px-3 py-2 text-xs ${
        isDangerous
          ? "border-amber-500/40 bg-amber-500/10"
          : "border-border/50 bg-muted/25"
      }`}
    >
      <div className="flex items-start gap-2">
        <Shield className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-foreground/90">{title}</div>
          {detail ? (
            <div className="mt-0.5 text-muted-foreground line-clamp-3 font-mono">
              {detail}
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="default"
          className="h-7 text-xs"
          onClick={() => onApprove(id)}
        >
          Allow
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => onReject(id)}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}

/** Pending permission prompts inline in the active assistant turn. */
export function InlinePermissionPrompts({ chatId }: { chatId: number }) {
  const queue = useAtomValue(permissionQueueAtom);
  const setQueue = useSetAtom(permissionQueueAtom);
  const loadedForChatRef = useRef<number | null>(null);

  useEffect(() => {
    if (loadedForChatRef.current === chatId) return;
    loadedForChatRef.current = chatId;

    const loadPermissions = async () => {
      try {
        const pending = await IpcClient.getInstance().getPendingPermissions({ chatId });
        pending.forEach((p) => {
          const request = p.request;
          const preview = request.preview as Record<string, unknown>;
          setQueue((q) => {
            if (q.has(p.id)) return q;
            return addOperation(q, {
              id: p.id,
              operation: (request.operation as QueuedOperation["operation"]) || "unknown",
              command: preview?.command as string | undefined,
              path: preview?.path as string | undefined,
              content: preview?.content as string | undefined,
              description: preview?.description as string | undefined,
              preview: JSON.stringify(request.preview, null, 2).slice(0, 500),
              status: "pending",
              isDangerous: preview?.isDangerous as boolean | undefined,
              dangerExplanation: preview?.dangerExplanation as string | undefined,
            });
          });
        });
      } catch {
        /* ignore */
      }
    };
    void loadPermissions();

    const unsubscribe = IpcClient.getInstance().onPermissionRequest(chatId, (payload) => {
      const request = payload.request;
      const preview = request.preview as Record<string, unknown>;
      setQueue((q) => {
        if (q.has(payload.operationId)) return q;
        return addOperation(q, {
          id: payload.operationId,
          operation: (request.operation as QueuedOperation["operation"]) || "unknown",
          command: preview?.command as string | undefined,
          path: preview?.path as string | undefined,
          description: preview?.description as string | undefined,
          preview: JSON.stringify(request.preview, null, 2).slice(0, 500),
          status: "pending",
          isDangerous: preview?.isDangerous as boolean | undefined,
        });
      });
    });
    return () => {
      if (loadedForChatRef.current === chatId) {
        loadedForChatRef.current = null;
      }
      unsubscribe();
    };
  }, [chatId, setQueue]);

  const pending = getOperationsByStatus(queue, "pending");

  const handleApprove = useCallback(
    async (id: string) => {
      setQueue((q) => updateOperationStatus(q, id, { status: "queued" }));
      await IpcClient.getInstance().executePermission({ chatId, operationId: id });
    },
    [chatId, setQueue],
  );

  const handleReject = useCallback(
    async (id: string) => {
      setQueue((q) => removeOperation(q, id));
      await IpcClient.getInstance().rejectPermission({ chatId, operationId: id });
    },
    [chatId, setQueue],
  );

  if (!pending.length) return null;

  return (
    <div className="space-y-0">
      {pending.map((op) => (
        <InlinePermissionCard
          key={op.id}
          chatId={chatId}
          id={op.id}
          title={
            op.description?.trim() ||
            op.path?.trim() ||
            op.command?.trim() ||
            op.operation.replace(/_/g, " ")
          }
          detail={op.dangerExplanation ?? op.preview}
          isDangerous={op.isDangerous}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      ))}
    </div>
  );
}
