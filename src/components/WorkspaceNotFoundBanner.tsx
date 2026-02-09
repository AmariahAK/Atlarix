/**
 * Shown when the selected workspace folder no longer exists on disk (deleted outside app).
 * Offers Remove from list and clears selection.
 */

import { useAtomValue, useSetAtom } from "jotai";
import {
  currentAppAtom,
  selectedAppIdAtom,
  appsListAtom,
  appBasePathAtom,
} from "@/atoms/appAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";

export function WorkspaceNotFoundBanner() {
  const currentApp = useAtomValue(currentAppAtom);
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const setSelectedAppId = useSetAtom(selectedAppIdAtom);
  const setCurrentApp = useSetAtom(currentAppAtom);
  const setAppsList = useSetAtom(appsListAtom);
  const setAppBasePath = useSetAtom(appBasePathAtom);

  if (
    !selectedAppId ||
    !currentApp ||
    currentApp.id !== selectedAppId ||
    currentApp.pathExists !== false
  ) {
    return null;
  }

  const handleRemove = async () => {
    try {
      const ipc = IpcClient.getInstance();
      await ipc.deleteApp(selectedAppId);
      setSelectedAppId(null);
      setCurrentApp(null);
      const list = await ipc.listApps();
      setAppsList(list.apps);
      setAppBasePath(list.appBasePath);
    } catch (err) {
      console.error("Failed to remove workspace:", err);
    }
  };

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3 bg-amber-500/10 dark:bg-amber-600/10 border-b border-amber-500/20 text-sm">
      <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>
          Workspace folder not found. It may have been moved or deleted outside Atlarix.
        </span>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={handleRemove}
        className="shrink-0 border-amber-500/30 hover:bg-amber-500/10"
      >
        Remove from list
      </Button>
    </div>
  );
}
