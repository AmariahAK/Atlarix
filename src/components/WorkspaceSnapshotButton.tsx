/**
 * Workspace Snapshot Button (Pro)
 * ==============================
 * Save/restore workspace state from the chat header.
 */

import { useState } from "react";
import { useAtomValue } from "jotai";
import { useQuery } from "@tanstack/react-query";
import {
  selectedAppIdAtom,
  userSettingsAtom,
} from "@/atoms/appAtoms";
import {
  selectedChatIdAtom,
  chatMessagesByIdAtom,
} from "@/atoms/chatAtoms";
import { IpcClient } from "@/ipc/ipc_client";
import { showSuccess, showError } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Camera, Loader2, HardDrive } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { triggerUpgrade } from "@/hooks/useUpgrade";

export function WorkspaceSnapshotButton() {
  const appId = useAtomValue(selectedAppIdAtom);
  const chatId = useAtomValue(selectedChatIdAtom);
  const messagesById = useAtomValue(chatMessagesByIdAtom);
  const settings = useAtomValue(userSettingsAtom);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const queryClient = useQueryClient();

  const isPro = settings?.enableAtlarixPro === true;
  const messages = (chatId != null ? messagesById.get(chatId) : undefined) ?? [];
  const chatMessages = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const { data: listResult } = useQuery({
    queryKey: ["workspace-snapshots", appId],
    queryFn: () => IpcClient.getInstance().listWorkspaceSnapshots(appId!),
    enabled: !!appId && isPro && open,
  });

  const snapshots = listResult?.success ? listResult.snapshots ?? [] : [];

  const handleSave = async () => {
    if (!appId || !name.trim() || !isPro) {
      if (!isPro) triggerUpgrade();
      return;
    }
    setSaving(true);
    try {
      const res = await IpcClient.getInstance().createWorkspaceSnapshot({
        appId,
        name: name.trim(),
        chatMessages: chatMessages.length > 0 ? chatMessages : undefined,
      });
      if (res.success) {
        showSuccess("Snapshot saved");
        setName("");
        setOpen(false);
        queryClient.invalidateQueries({ queryKey: ["workspace-snapshots", appId] });
      } else {
        showError(res.error ?? "Failed to save snapshot");
      }
    } catch {
      showError("Failed to save snapshot");
    } finally {
      setSaving(false);
    }
  };

  const handleRestore = async (snapshotId: number) => {
    if (!appId || !isPro) return;
    setRestoring(true);
    try {
      const res = await IpcClient.getInstance().restoreWorkspaceSnapshot({
        snapshotId,
        appId,
      });
      if (res.success) {
        showSuccess("Snapshot restored. Reload the workspace to see changes.");
        setOpen(false);
      } else {
        showError(res.error ?? "Failed to restore");
      }
    } catch {
      showError("Failed to restore snapshot");
    } finally {
      setRestoring(false);
    }
  };

  if (!appId) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => !isPro && triggerUpgrade()}
        >
          <Camera className="w-4 h-4" />
          <span className="hidden sm:inline">Snapshot</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <div className="space-y-3">
          <h4 className="font-medium flex items-center gap-2">
            <HardDrive className="w-4 h-4" />
            Workspace Snapshots {!isPro && "(Pro)"}
          </h4>
          {!isPro ? (
            <p className="text-sm text-muted-foreground">
              Upgrade to Pro to save and restore workspace state.
            </p>
          ) : (
            <>
              <div className="flex gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Snapshot name"
                  className="flex-1 px-2 py-1.5 text-sm rounded border"
                />
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={!name.trim() || saving}
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Save"}
                </Button>
              </div>
              {snapshots.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Restore:</p>
                  {snapshots.slice(0, 5).map((s) => (
                    <button
                      key={s.id}
                      onClick={() => handleRestore(s.id)}
                      disabled={restoring}
                      className="w-full flex items-center justify-between px-2 py-1.5 text-sm rounded hover:bg-muted"
                    >
                      <span>{s.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {s.fileCount} files
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
