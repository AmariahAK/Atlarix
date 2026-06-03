import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  addOperation,
  getOperationsByStatus,
  permissionQueueAtom,
  removeOperation,
  updateOperationStatus,
  type QueuedOperation,
} from "@/atoms/permissionQueueAtom";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";
import { SmartDiffView } from "@/components/SmartDiffView";
import { Shield, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const FILE_OPERATIONS = new Set([
  "write_file",
  "edit_file",
  "write_multiple_files",
  "delete_file",
  "rename_file",
  "batch_plan",
  "batch_refactor",
  "replace_code",
  "insert_code",
  "delete_lines",
]);

function isFileOperation(op: QueuedOperation["operation"]): boolean {
  return FILE_OPERATIONS.has(op);
}

function queueEntryFromPermission(
  operationId: string,
  request: { operation: string; preview: unknown },
): Omit<QueuedOperation, "timestamp"> {
  const preview = request.preview as Record<string, unknown>;
  const files = Array.isArray(request.preview) ? request.preview : null;

  if (request.operation === "write_multiple_files" && files?.length) {
    const first = files[0] as { path?: string; content?: string; oldContent?: string };
    return {
      id: operationId,
      operation: "write_multiple_files",
      path: first.path,
      content: first.content,
      oldContent: first.oldContent,
      description: `${files.length} files`,
      preview: JSON.stringify(request.preview, null, 2).slice(0, 800),
      status: "pending",
    };
  }

  return {
    id: operationId,
    operation: (request.operation as QueuedOperation["operation"]) || "unknown",
    command: preview.command as string | undefined,
    path: preview.path as string | undefined,
    content: preview.content as string | undefined,
    oldContent: preview.oldContent as string | undefined,
    description: preview.description as string | undefined,
    preview: JSON.stringify(request.preview, null, 2).slice(0, 800),
    status: "pending",
    isDangerous: preview.isDangerous as boolean | undefined,
    dangerExplanation: preview.dangerExplanation as string | undefined,
    commandCategory: preview.commandCategory as string | undefined,
    canAlwaysAllow: preview.canAlwaysAllow as boolean | undefined,
    isProtectedFile: preview.isProtectedFile as boolean | undefined,
    isDeleteOrRename: preview.isDeleteOrRename as boolean | undefined,
    canAlwaysAllowFile: preview.canAlwaysAllowFile as boolean | undefined,
    canAlwaysAllowDirectory: preview.canAlwaysAllowDirectory as boolean | undefined,
    canAlwaysAllowExtension: preview.canAlwaysAllowExtension as boolean | undefined,
    fileParentDir: preview.fileParentDir as string | undefined,
    fileExtension: preview.fileExtension as string | undefined,
    ...(request.operation === "batch_plan" && {
      batchPlanTitle: preview.title as string | undefined,
      batchPlanSummary: preview.summary as string | undefined,
      batchPlanOperationsCount: Array.isArray(preview.operations)
        ? preview.operations.length
        : 0,
    }),
  };
}

function FilePermissionCard({
  operation,
  appId,
  onOnce,
  onAlwaysFile,
  onAlwaysDirectory,
  onAlwaysExtension,
  onDeny,
}: {
  operation: QueuedOperation;
  appId: number | null;
  onOnce: (id: string) => void;
  onAlwaysFile: (id: string) => void;
  onAlwaysDirectory: (id: string) => void;
  onAlwaysExtension: (id: string) => void;
  onDeny: (id: string) => void;
}) {
  const title =
    operation.description?.trim() ||
    operation.path?.trim() ||
    operation.operation.replace(/_/g, " ");

  const isProtected = Boolean(operation.isProtectedFile);
  const isDeleteOrRename =
    Boolean(operation.isDeleteOrRename) ||
    operation.operation === "delete_file" ||
    operation.operation === "rename_file";
  const parentDir = operation.fileParentDir?.trim();
  const extension = operation.fileExtension?.trim();
  const showScopedAlways =
    !isProtected &&
    !isDeleteOrRename &&
    appId != null &&
    (operation.canAlwaysAllowFile !== false ||
      operation.canAlwaysAllowDirectory !== false ||
      operation.canAlwaysAllowExtension !== false);

  return (
    <div className="my-2 rounded-lg border border-border/60 bg-muted/20 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40">
        <Shield className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground/90 truncate">{title}</span>
      </div>
      {isDeleteOrRename ? (
        <p className="px-3 py-2 text-[11px] text-amber-900 dark:text-amber-100/90">
          This change removes or renames a file. Directory and extension rules never auto-approve
          deletes — use Allow once to proceed.
        </p>
      ) : null}
      {isProtected ? (
        <p className="px-3 py-1.5 text-[11px] text-muted-foreground">
          Protected path — only Allow once or Deny.
        </p>
      ) : null}
      <div className="px-2 pb-2">
        {operation.path && operation.content != null && operation.oldContent !== undefined ? (
          <SmartDiffView
            path={operation.path}
            oldContent={operation.oldContent}
            newContent={operation.content}
            description={operation.description}
            operation="update"
            maxHeight="max-h-56"
          />
        ) : operation.content ? (
          <pre className="text-[11px] bg-[var(--diff-add-bg,theme(colors.emerald.500/10))] text-foreground/80 p-2 rounded overflow-x-auto max-h-40">
            {operation.content.split("\n").slice(0, 24).join("\n")}
          </pre>
        ) : operation.preview ? (
          <pre className="text-[11px] text-muted-foreground p-2 overflow-x-auto max-h-32">
            {operation.preview}
          </pre>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2 px-3 pb-2">
        <Button type="button" size="sm" className="h-7 text-xs" onClick={() => onOnce(operation.id)}>
          Allow once
        </Button>
        {showScopedAlways && operation.canAlwaysAllowFile !== false && operation.path ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 text-xs"
            onClick={() => onAlwaysFile(operation.id)}
          >
            Always allow this file
          </Button>
        ) : null}
        {showScopedAlways && operation.canAlwaysAllowDirectory !== false && parentDir ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 text-xs"
            onClick={() => onAlwaysDirectory(operation.id)}
          >
            Always allow {parentDir}/**
          </Button>
        ) : null}
        {showScopedAlways && operation.canAlwaysAllowExtension !== false && extension ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 text-xs"
            onClick={() => onAlwaysExtension(operation.id)}
          >
            Always allow {extension}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => onDeny(operation.id)}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}

function CommandPermissionCard({
  operation,
  appId,
  onOnce,
  onAlways,
  onDeny,
}: {
  operation: QueuedOperation;
  appId: number | null;
  onOnce: (id: string, dangerAcknowledged?: boolean) => void;
  onAlways: (id: string, dangerAcknowledged?: boolean) => void;
  onDeny: (id: string) => void;
}) {
  const [dangerAcknowledged, setDangerAcknowledged] = useState(false);
  const isDangerous = Boolean(operation.isDangerous);
  const canAlwaysAllow = operation.canAlwaysAllow !== false && !isDangerous;
  const category = operation.commandCategory ?? "command";
  const canApprove = !isDangerous || dangerAcknowledged;

  return (
    <div
      className={cn(
        "my-2 rounded-lg border px-3 py-2 text-xs",
        isDangerous
          ? "border-amber-500/40 bg-amber-500/10"
          : "border-border/60 bg-muted/20",
      )}
    >
      <div className="flex items-start gap-2">
        <Terminal className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-foreground/90">Run command</div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground break-all bg-background/60 rounded px-2 py-1.5">
            $ {operation.command}
          </div>
          {isDangerous && operation.dangerExplanation ? (
            <p className="mt-1.5 text-amber-900 dark:text-amber-100/90">
              {operation.dangerExplanation}
            </p>
          ) : null}
        </div>
      </div>
      {isDangerous ? (
        <label className="mt-2 flex items-center gap-2 text-[11px] text-amber-900 dark:text-amber-200">
          <input
            type="checkbox"
            checked={dangerAcknowledged}
            onChange={(e) => setDangerAcknowledged(e.target.checked)}
            className="rounded border-amber-500/50"
          />
          I understand the risks
        </label>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          className="h-7 text-xs"
          disabled={!canApprove}
          onClick={() =>
            onOnce(operation.id, isDangerous ? dangerAcknowledged : undefined)
          }
        >
          Allow once
        </Button>
        {canAlwaysAllow ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 text-xs"
            disabled={!canApprove || appId == null}
            title={appId == null ? "Select a workspace to save rules" : undefined}
            onClick={() =>
              onAlways(operation.id, isDangerous ? dangerAcknowledged : undefined)
            }
          >
            Always allow {category}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => onDeny(operation.id)}
        >
          Deny
        </Button>
      </div>
    </div>
  );
}

/** Inline permission approvals with diffs and workspace terminal categories. */
export function InlinePermissionApprovals({ chatId }: { chatId: number }) {
  const queue = useAtomValue(permissionQueueAtom);
  const setQueue = useSetAtom(permissionQueueAtom);
  const appId = useAtomValue(selectedAppIdAtom);
  const loadedForChatRef = useRef<number | null>(null);

  useEffect(() => {
    if (loadedForChatRef.current === chatId) return;
    loadedForChatRef.current = chatId;

    const loadPermissions = async () => {
      try {
        const pending = await IpcClient.getInstance().getPendingPermissions({ chatId });
        pending.forEach((p) => {
          setQueue((q) => {
            if (q.has(p.id)) return q;
            return addOperation(q, queueEntryFromPermission(p.id, p.request));
          });
        });
      } catch {
        /* ignore */
      }
    };
    void loadPermissions();

    const unsubscribe = IpcClient.getInstance().onPermissionRequest(chatId, (payload) => {
      setQueue((q) => {
        if (q.has(payload.operationId)) return q;
        return addOperation(q, queueEntryFromPermission(payload.operationId, payload.request));
      });
    });

    const blockedUnsub = IpcClient.getInstance().onCommandPermissionBlocked(chatId, (payload) => {
      toast.error(payload.message ?? "Command blocked");
    });

    const fileBlockedUnsub = IpcClient.getInstance().onFilePermissionBlocked(chatId, (payload) => {
      toast.error(payload.message ?? "File edit blocked");
    });

    return () => {
      if (loadedForChatRef.current === chatId) loadedForChatRef.current = null;
      unsubscribe();
      blockedUnsub?.();
      fileBlockedUnsub?.();
    };
  }, [chatId, setQueue]);

  const pending = getOperationsByStatus(queue, "pending");
  const filePending = useMemo(
    () => pending.filter((op) => isFileOperation(op.operation)),
    [pending],
  );
  const commandPending = useMemo(
    () => pending.filter((op) => op.operation === "run_command"),
    [pending],
  );
  const otherPending = useMemo(
    () => pending.filter((op) => !isFileOperation(op.operation) && op.operation !== "run_command"),
    [pending],
  );

  const runFileApproval = useCallback(
    async (
      id: string,
      approvalMode:
        | "once"
        | "always_allow_file"
        | "always_allow_directory"
        | "always_allow_extension"
        | "deny",
    ) => {
      setQueue((q) => updateOperationStatus(q, id, { status: "queued" }));
      await IpcClient.getInstance().executePermission({
        chatId,
        operationId: id,
        approvalMode,
        appId: approvalMode === "once" || approvalMode === "deny" ? undefined : (appId ?? undefined),
      });
    },
    [chatId, setQueue, appId],
  );

  const handleFileOnce = useCallback(
    (id: string) => void runFileApproval(id, "once"),
    [runFileApproval],
  );

  const handleFileAlwaysFile = useCallback(
    (id: string) => void runFileApproval(id, "always_allow_file"),
    [runFileApproval],
  );

  const handleFileAlwaysDirectory = useCallback(
    (id: string) => void runFileApproval(id, "always_allow_directory"),
    [runFileApproval],
  );

  const handleFileAlwaysExtension = useCallback(
    (id: string) => void runFileApproval(id, "always_allow_extension"),
    [runFileApproval],
  );

  const handleFileDeny = useCallback(
    async (id: string) => {
      setQueue((q) => removeOperation(q, id));
      await IpcClient.getInstance().executePermission({
        chatId,
        operationId: id,
        approvalMode: "deny",
      });
    },
    [chatId, setQueue],
  );

  const handleCommandOnce = useCallback(
    async (id: string, dangerAcknowledged?: boolean) => {
      setQueue((q) => updateOperationStatus(q, id, { status: "queued" }));
      await IpcClient.getInstance().executePermission({
        chatId,
        operationId: id,
        approvalMode: "once",
        dangerAcknowledged,
      });
    },
    [chatId, setQueue],
  );

  const handleCommandAlways = useCallback(
    async (id: string, dangerAcknowledged?: boolean) => {
      setQueue((q) => updateOperationStatus(q, id, { status: "queued" }));
      await IpcClient.getInstance().executePermission({
        chatId,
        operationId: id,
        approvalMode: "always_allow",
        appId: appId ?? undefined,
        dangerAcknowledged,
      });
    },
    [chatId, setQueue, appId],
  );

  const handleCommandDeny = useCallback(
    async (id: string) => {
      setQueue((q) => removeOperation(q, id));
      await IpcClient.getInstance().executePermission({
        chatId,
        operationId: id,
        approvalMode: "deny",
      });
    },
    [chatId, setQueue],
  );

  const handleApproveAllFiles = useCallback(async () => {
    for (const op of filePending) {
      await handleFileOnce(op.id);
    }
  }, [filePending, handleFileOnce]);

  const handleRejectAllFiles = useCallback(async () => {
    for (const op of filePending) {
      await handleFileDeny(op.id);
    }
  }, [filePending, handleFileDeny]);

  if (!pending.length) return null;

  return (
    <div className="space-y-0">
      {filePending.length >= 2 ? (
        <div className="my-2 flex flex-wrap gap-2 rounded-lg border border-border/50 bg-muted/15 px-3 py-2">
          <span className="text-xs text-muted-foreground w-full">
            {filePending.length} file changes awaiting approval
          </span>
          <Button type="button" size="sm" className="h-7 text-xs" onClick={() => void handleApproveAllFiles()}>
            Approve all files
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => void handleRejectAllFiles()}
          >
            Reject all
          </Button>
        </div>
      ) : null}
      {filePending.map((op) => (
        <FilePermissionCard
          key={op.id}
          operation={op}
          appId={appId}
          onOnce={handleFileOnce}
          onAlwaysFile={handleFileAlwaysFile}
          onAlwaysDirectory={handleFileAlwaysDirectory}
          onAlwaysExtension={handleFileAlwaysExtension}
          onDeny={handleFileDeny}
        />
      ))}
      {commandPending.map((op) => (
        <CommandPermissionCard
          key={op.id}
          operation={op}
          appId={appId}
          onOnce={handleCommandOnce}
          onAlways={handleCommandAlways}
          onDeny={handleCommandDeny}
        />
      ))}
      {otherPending.map((op) => (
        <FilePermissionCard
          key={op.id}
          operation={op}
          appId={appId}
          onOnce={handleFileOnce}
          onAlwaysFile={handleFileAlwaysFile}
          onAlwaysDirectory={handleFileAlwaysDirectory}
          onAlwaysExtension={handleFileAlwaysExtension}
          onDeny={handleFileDeny}
        />
      ))}
    </div>
  );
}
