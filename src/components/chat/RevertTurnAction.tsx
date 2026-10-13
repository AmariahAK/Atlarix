/**
 * v13.1: "Revert this turn's file changes" — a Cursor-style checkpoint on an
 * assistant message whose turn captured a shadow-git snapshot. Restores the
 * files this turn wrote to their pre-turn state (deleting files it created)
 * WITHOUT rewinding the conversation. The snapshotTurnId is persisted
 * (session_messages.snapshot_turn_id, migration 0063) and snapshots live on
 * disk, so this survives an app restart — the map is rehydrated on session load
 * (WorkspaceSessionList) and on any chat load (SimpleInlineChat fetchMessages →
 * sessions:snapshot-turn-ids).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAtomValue } from "jotai";
import { Undo2, Loader2 } from "lucide-react";
import { turnSnapshotTurnIdByMessageIdAtom } from "@/atoms/chatAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { showError, showSuccess } from "@/lib/toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export function RevertTurnAction({
  chatId,
  messageId,
}: {
  chatId: number | undefined;
  messageId: number;
}) {
  const { t } = useTranslation("chat");
  const snapshotMap = useAtomValue(turnSnapshotTurnIdByMessageIdAtom);
  const turnId = snapshotMap.get(messageId);
  const [open, setOpen] = useState(false);
  // undefined while loading; null when the turn captured no snapshot.
  const [files, setFiles] = useState<
    | { filesChanged: string[]; createdFiles: string[]; revertedAt?: string }
    | null
    | undefined
  >(undefined);
  const [loading, setLoading] = useState(false);
  const [reverted, setReverted] = useState(false);

  // What the turn changed, and whether it was already reverted (recorded with
  // the snapshot, so a reopened chat shows it too instead of offering Revert
  // again). A turn that changed no files offers nothing.
  useEffect(() => {
    if (chatId == null || !turnId) return;
    let live = true;
    IpcClient.getInstance()
      .getSnapshotFiles({ chatId, turnId })
      .then((f) => live && setFiles(f ?? null))
      .catch(() => live && setFiles(null));
    return () => {
      live = false;
    };
  }, [chatId, turnId]);

  if (chatId == null || !turnId || !files) return null;
  if (files.filesChanged.length + files.createdFiles.length === 0) return null;

  if (reverted || files.revertedAt) {
    const all = [...new Set([...files.filesChanged, ...files.createdFiles])];
    return (
      <span
        data-reverted
        className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground"
        title={t("revertTurn.revertedTitle", { files: all.join(", ") })}
      >
        <Undo2 className="h-3 w-3" />
        {t("revertTurn.reverted")}
      </span>
    );
  }

  const openDialog = () => setOpen(true);

  const doRevert = async () => {
    setLoading(true);
    try {
      const res = await IpcClient.getInstance().revertSnapshot(chatId, turnId, {
        filesOnly: true,
      });
      if (res?.success) {
        setReverted(true);
        showSuccess(
          `Reverted this turn's file changes (${res.restoredFiles ?? 0} restored).`,
        );
      } else {
        showError(res?.error ?? "Revert failed");
      }
    } catch (err) {
      showError(err);
    } finally {
      setLoading(false);
      setOpen(false);
    }
  };

  const changed = files?.filesChanged.length ?? 0;
  const created = files?.createdFiles.length ?? 0;

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        disabled={loading}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-muted"
        title="Revert this turn's file changes"
      >
        {loading ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Undo2 className="h-3 w-3" />
        )}
        Revert
      </button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revert this turn's file changes?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-xs">
                <p>
                  Restores {changed} file(s) to their state before this turn
                  {created > 0
                    ? `; ${created} file(s) created this turn will be deleted`
                    : ""}
                  .
                </p>
                {files && files.filesChanged.length > 0 ? (
                  <pre className="max-h-32 overflow-auto rounded border border-border bg-muted/40 p-2 font-mono">
                    {files.filesChanged.join("\n")}
                  </pre>
                ) : (
                  <p className="text-muted-foreground">
                    No file changes were recorded for this turn.
                  </p>
                )}
                <p className="text-amber-600 dark:text-amber-500">
                  Edits made by later turns to these files will be overwritten —
                  this does not undo later turns.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void doRevert();
              }}
              disabled={loading || changed === 0}
            >
              Revert files
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
