import { useNavigate } from "@tanstack/react-router";
import { useAtom, useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import AtlarixAnimation from "@/components/atlarix/AtlarixAnimation";
import { Button } from "@/components/ui/button";
import { selectedAppIdAtom, selectedWorkspaceInfoAtom } from "@/atoms/appAtoms";
import { activeChatIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
import { clearDeletedWorkspaceClientState } from "@/lib/workspace-delete-cleanup";
import {
  subscribeWorkspaceDeleted,
  type WorkspaceDeletedPayload,
} from "@/lib/renderer-ipc-bridge";
import { IpcClient } from "@/ipc/ipc_client";

/**
 * What a window does when the workspace it is standing in is deleted somewhere
 * else.
 *
 * WHAT IT USED TO DO: nothing at all. `delete-app` broadcast no event, and
 * `useLoadApps` only reacts to `apps:status-changed`, whose reducer patches ids
 * it already has — so a deleted id was never removed from any other window's
 * list, not even on focus. That window kept a working-looking sidebar, session
 * list and composer, and the lie held until the next turn failed somewhere deep
 * writing to a chat row that had been cascaded away.
 *
 * WHY BLOCK RATHER THAN REDIRECT. Silently dropping the user on the launcher
 * throws away what is on screen and never says why — and the interesting case is
 * precisely the one where something WAS happening: main aborts the live turns
 * before it deletes the files, so this screen is often the only place anyone is
 * told that a turn was cancelled. Closing the window would be worse still: if it
 * is the last one, that quits the app.
 *
 * So it stops, says what happened, and leaves the exit to the user.
 */
export function WorkspaceDeletedScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedAppId, setSelectedAppId] = useAtom(selectedAppIdAtom);
  const setSelectedWorkspaceInfo = useSetAtom(selectedWorkspaceInfoAtom);
  const setActiveChatId = useSetAtom(activeChatIdAtom);
  const setSelectedChatId = useSetAtom(selectedChatIdAtom);
  const [deleted, setDeleted] = useState<WorkspaceDeletedPayload | null>(null);

  useEffect(() => {
    return subscribeWorkspaceDeleted((payload) => {
      // Only the window standing in THIS workspace blocks. Everyone else just
      // needs their list corrected, which the cleanup below already handles as
      // a no-op for a non-matching selection — which is why main can broadcast
      // to every window rather than tracking who has what open.
      if (payload.appId !== selectedAppId) return;
      setDeleted(payload);
    });
  }, [selectedAppId]);

  if (!deleted) return null;

  const backToLauncher = () => {
    clearDeletedWorkspaceClientState(deleted.appId, queryClient);
    setSelectedAppId(null);
    setSelectedWorkspaceInfo(null);
    setActiveChatId(null);
    setSelectedChatId(null);
    setDeleted(null);
    void navigate({ to: "/" });
  };

  const turns = deleted.cancelledTurns ?? 0;

  return (
    <div
      data-testid="workspace-deleted"
      // Covers the whole route outlet and takes the clicks with it. A window
      // that is still accepting input into a workspace that no longer exists is
      // the thing this screen exists to stop.
      className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background px-6 text-center"
    >
      <AtlarixAnimation size="sm" phase="done" minimalChrome theme="auto" />
      <h1 className="text-lg font-semibold tracking-tight">
        {deleted.name ? `“${deleted.name}” was removed` : "Workspace removed"}
      </h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        This workspace was deleted in another window, so this one can no longer
        open its files or sessions.
      </p>
      {turns > 0 ? (
        <p className="max-w-sm text-xs text-muted-foreground/80">
          {turns === 1
            ? "A turn was running here and has been cancelled."
            : `${turns} turns were running here and have been cancelled.`}{" "}
          Anything they had not finished was not saved.
        </p>
      ) : null}
      {deleted.path ? (
        <p className="max-w-md truncate font-mono text-xs text-muted-foreground/70">
          {deleted.path}
        </p>
      ) : null}
      <div className="flex items-center gap-2 pt-2">
        <Button size="sm" onClick={backToLauncher}>
          Back to launcher
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void IpcClient.getInstance().closeWindow()}
        >
          Close window
        </Button>
      </div>
    </div>
  );
}
