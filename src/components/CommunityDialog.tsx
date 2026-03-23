import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { IpcClient } from "@/ipc/ipc_client";
import type { DiscordInviteInfoResult } from "@/ipc/ipc_types";
import {
  DEFAULT_COMMUNITY_TAGLINE,
  DISCORD_INVITE_URL,
} from "@/lib/community/discord";
import { Users, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

export function CommunityDialog() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<DiscordInviteInfoResult | null>(null);

  const loadInviteInfo = useCallback(() => {
    setLoading(true);
    IpcClient.getInstance()
      .getDiscordInviteInfo()
      .then(setInfo)
      .catch(() => setInfo({ ok: false }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const ipc = window.electron?.ipcRenderer;
    if (!ipc) return;
    const unsub = ipc.on("open-community-dialog", () => setOpen(true));
    return () => unsub?.();
  }, []);

  useEffect(() => {
    if (!open) {
      setInfo(null);
      return;
    }
    loadInviteInfo();
  }, [open, loadInviteInfo]);

  const title =
    info?.ok === true ? info.name : "Atlarix Community";
  const description =
    info?.ok === true && info.description
      ? info.description
      : DEFAULT_COMMUNITY_TAGLINE;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 shrink-0 text-primary" />
            {title}
          </DialogTitle>
          <DialogDescription className="text-left pt-1">
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm space-y-2">
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin shrink-0" />
              Loading community info…
            </div>
          ) : info?.ok === true &&
            (info.memberCount != null || info.presenceCount != null) ? (
            <div className="space-y-1 text-muted-foreground">
              {info.memberCount != null && (
                <p>
                  <span className="text-foreground font-medium tabular-nums">
                    {info.memberCount.toLocaleString()}
                  </span>{" "}
                  members
                </p>
              )}
              {info.presenceCount != null && (
                <p>
                  <span className="text-foreground font-medium tabular-nums">
                    {info.presenceCount.toLocaleString()}
                  </span>{" "}
                  online now
                </p>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground">
              Hang out with other builders, get updates, and share feedback.
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button
            onClick={() => {
              void IpcClient.getInstance().openExternalUrl(DISCORD_INVITE_URL);
            }}
          >
            Join Discord
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
