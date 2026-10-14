import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IpcClient } from "@/ipc/ipc_client";
import { showError, showInfo, showSuccess } from "@/lib/toast";
import type { AddedServer } from "@/lib/mcp/mcp-add";

/**
 * What happens after a server is added, wherever it was added from (the
 * marketplace, a paste, an import): a browser sign-in when it needs one, a
 * prompt for a key it still lacks, and one line saying how it went.
 */
export function useMcpAddFlow(appId: number) {
  const queryClient = useQueryClient();
  const { t } = useTranslation("settings");
  const [secretFor, setSecretFor] = useState<{ id: string; name: string; header: string | null } | null>(null);
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["mcp"] });
    void queryClient.invalidateQueries({ queryKey: ["mcp-catalog", "search"] });
  }, [queryClient]);

  const finishOne = useCallback(
    async (added: AddedServer) => {
      const ipc = IpcClient.getInstance();
      if (added.needsSignIn) {
        if (added.note) showInfo(`${added.name}: ${added.note}`);
        showInfo(`Sign in to ${added.name} in your browser.`);
        if (added.where === "account") {
          const r = await ipc.signInAccountMcp({ id: String(added.id), appId });
          refresh();
          if (r.ok) showSuccess(r.enabled ? `${added.name} is on.` : `${added.name} is signed in.`);
          else showError(r.error ?? `Couldn't sign in to ${added.name}.`);
          if (r.ok && r.error) showInfo(r.error);
        } else {
          await ipc.startMcpOAuth({ serverId: Number(added.id) });
        }
        return;
      }
      if (added.needsSecret && added.where === "account") {
        setSecret("");
        setSecretFor({ id: String(added.id), name: added.name, header: added.needsSecret.header });
        return;
      }
      if (added.note) showInfo(`${added.name}: ${added.note}`);
      else showSuccess(`${added.name} added.`);
    },
    [appId, refresh],
  );

  const finish = useCallback(
    async (list: AddedServer[]) => {
      refresh();
      for (const a of list) await finishOne(a);
    },
    [finishOne, refresh],
  );

  const saveSecret = async () => {
    if (!secretFor || !secret.trim()) return;
    setSaving(true);
    try {
      await IpcClient.getInstance().setAccountMcpSecret({ id: secretFor.id, secret: secret.trim(), appId });
      showSuccess(`${secretFor.name} added.`);
      setSecretFor(null);
      refresh();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const dialog = (
    <Dialog open={secretFor != null} onOpenChange={(o) => !o && setSecretFor(null)}>
      {secretFor && (
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{secretFor.name}</DialogTitle>
          </DialogHeader>
          <Input
            type="password"
            autoFocus
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void saveSecret()}
            placeholder={secretFor.header ?? "API key"}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSecretFor(null)} disabled={saving}>
              {t("mcp.later")}
            </Button>
            <Button onClick={() => void saveSecret()} disabled={saving || !secret.trim()}>
              {t("mcp.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );

  return { finish, dialog, refresh };
}
