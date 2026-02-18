import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCreateApp } from "@/hooks/useCreateApp";
import { useCheckName } from "@/hooks/useCheckName";
import { useSetAtom } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { NEON_TEMPLATE_IDS, Template } from "@/shared/templates";

import { useRouter } from "@tanstack/react-router";

import { Loader2, FolderOpen } from "lucide-react";
import { neonTemplateHook } from "@/client_logic/template_hook";
import { showError } from "@/lib/toast";

declare const window: Window & { electron?: { ipcRenderer: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } } };

interface CreateAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: Template | undefined;
}

export function CreateAppDialog({
  open,
  onOpenChange,
  template,
}: CreateAppDialogProps) {
  const setSelectedAppId = useSetAtom(selectedAppIdAtom);
  const [appName, setAppName] = useState("");
  const [targetParentDir, setTargetParentDir] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { createApp } = useCreateApp();
  const { data: nameCheckResult } = useCheckName(appName);
  const router = useRouter();

  const handleChooseFolder = async () => {
    const result = await window.electron?.ipcRenderer.invoke("dialog:openDirectory") as { canceled?: boolean; filePaths?: string[] };
    if (result?.canceled || !result?.filePaths?.length) return;
    setTargetParentDir(result.filePaths[0]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!appName.trim()) {
      return;
    }

    if (nameCheckResult?.exists) {
      return;
    }

    setIsSubmitting(true);
    try {
      const targetPath = targetParentDir && appName.trim()
        ? `${targetParentDir.replace(/\/$/, "")}/${appName.trim()}`
        : undefined;
      const result = await createApp({ name: appName.trim(), targetPath });
      if (template && NEON_TEMPLATE_IDS.has(template.id)) {
        await neonTemplateHook({
          appId: result.app.id,
          appName: result.app.name,
        });
      }
      setSelectedAppId(result.app.id);
      // Navigate to the new app's first chat
      router.navigate({
        to: "/chat",
        search: { id: result.chatId },
      });
      setAppName("");
      setTargetParentDir(null);
      onOpenChange(false);
    } catch (error) {
      showError(error as any);
      // Error is already handled by createApp hook or shown above
      console.error("Error creating app:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const isNameValid = appName.trim().length > 0;
  const nameExists = nameCheckResult?.exists;
  const canSubmit = isNameValid && !nameExists && !isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Create New Workspace</DialogTitle>
          <DialogDescription>
            {`Create a new app using the ${template?.title} template.`}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="appName">App Name</Label>
              <Input
                id="appName"
                value={appName}
                onChange={(e) => setAppName(e.target.value)}
                placeholder="Enter app name..."
                className={nameExists ? "border-red-500" : ""}
                disabled={isSubmitting}
              />
              {nameExists && (
                <p className="text-sm text-red-500">
                  An app with this name already exists
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label>Create in</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleChooseFolder}
                  disabled={isSubmitting}
                  className="flex items-center gap-1"
                >
                  <FolderOpen className="h-4 w-4" />
                  {targetParentDir ? "Change folder" : "Choose folder…"}
                </Button>
                {targetParentDir && (
                  <span className="text-sm text-muted-foreground truncate flex-1 self-center" title={targetParentDir}>
                    {targetParentDir}
                  </span>
                )}
              </div>
              {!targetParentDir && (
                <p className="text-xs text-muted-foreground">
                  Default: Documents/Atlarix
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit}
              className="bg-indigo-600 hover:bg-indigo-700"
            >
              {isSubmitting && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {isSubmitting ? "Creating..." : "Create App"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
