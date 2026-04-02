/**
 * Fix: Workforce-2 — modal when a Workforce tool needs per-chat scope; unblocks chat stream via IPC.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function WorkforceSessionPromptDialog() {
  const [open, setOpen] = useState(false);
  const [chatId, setChatId] = useState<number | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    const ipc = window.electron?.ipcRenderer;
    if (!ipc?.on) return;
    const handler = (_e: unknown, payload: { chatId?: number }) => {
      if (typeof payload?.chatId === "number") {
        setChatId(payload.chatId);
        setNote("");
        setOpen(true);
      }
    };
    ipc.on("workforce:prompt-session-scope", handler as never);
    return () => ipc.removeListener?.("workforce:prompt-session-scope", handler as never);
  }, []);

  const finish = useCallback(
    async (success: boolean) => {
      const ipc = window.electron?.ipcRenderer;
      if (chatId != null && ipc?.invoke) {
        if (success && note.trim()) {
          await ipc.invoke("workforce:session:set-scope", chatId, note.trim());
        }
        await ipc.invoke("workforce:session:complete-prompt", chatId, success && note.trim().length > 0);
      }
      setOpen(false);
      setChatId(null);
      setNote("");
    },
    [chatId, note],
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void finish(false);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Workforce scope for this chat</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Describe which Slack areas, repositories, or projects the assistant should prioritize for this
          conversation. Stored for this chat only; cleared when you start a new chat.
        </p>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Slack #engineering; GitHub org/repo acme/web; Jira project KEY"
          rows={4}
          className="resize-none"
        />
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={() => void finish(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void finish(true)} disabled={!note.trim()}>
            Save and continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
