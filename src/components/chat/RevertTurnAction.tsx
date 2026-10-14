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
import { keptFilesLine } from "@/lib/chat/kept-files-line";
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
    | {
        filesChanged: string[];
        createdFiles: string[];
        revertedAt?: string;
        endRecorded?: boolean;
        kept?: string[];
      }
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
        const restored = res.restoredFiles ?? 0;
        const kept = keptFilesLine(res.kept ?? []);
        // Every file changed since: nothing went back, so it isn't "reverted".
        if (restored > 0) setReverted(true);
        showSuccess(
          [
            restored > 0
              ? `Reverted ${restored} ${restored === 1 ? "file" : "files"}.`
              : null,
            kept,
          ]
            .filter(Boolean)
            .join(" "),
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

  // What will actually go back: a file changed since is kept (said below).
  const keptNow = new Set(files?.kept ?? []);
  const goingBack = (files?.filesChanged ?? []).filter((f) => !keptNow.has(f));
  const changed = goingBack.length;
  const created = (files?.createdFiles ?? []).filter((f) => !keptNow.has(f)).length;
  const keptLine = keptFilesLine([...keptNow]);

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
                  Restores {changed} {changed === 1 ? "file" : "files"} to
                  their state before this turn
                  {created > 0
                    ? `; ${created} ${created === 1 ? "file" : "files"} created this turn will be deleted`
                    : ""}
                  .
                </p>
                {goingBack.length > 0 ? (
                  <pre className="max-h-32 overflow-auto rounded border border-border bg-muted/40 p-2 font-mono">
                    {goingBack.join("\n")}
                  </pre>
                ) : keptNow.size === 0 ? (
                  <p className="text-muted-foreground">
                    No file changes were recorded for this turn.
                  </p>
                ) : null}
                {keptLine ? <p>{keptLine}</p> : null}
                {files?.endRecorded === false ? (
                  // A turn from before end states were recorded, or one that
                  // was stopped: changes made since can't be told apart.
                  <p className="text-amber-600 dark:text-amber-500">
                    {t("revertTurn.unchecked")}
                  </p>
                ) : null}
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
