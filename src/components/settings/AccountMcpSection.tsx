import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { IpcClient } from "@/ipc/ipc_client";
import { showError, showInfo, showSuccess } from "@/lib/toast";
import type { ConnectorView } from "@/lib/mcp/account-connectors";
import { useMcpAddFlow } from "./useMcpAddFlow";

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Web servers on the account: the same list in the app, the CLI, VS Code,
 * editors over ACP and the Chrome extension. Signed out: nothing to show.
 */
export function AccountMcpSection({ appId }: { appId: number }) {
  const ipc = IpcClient.getInstance();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const { finish, dialog } = useMcpAddFlow(appId);
  const { data } = useQuery({
    queryKey: ["mcp", "account"],
    queryFn: () => ipc.listAccountMcpServers(),
  });

  if (!data || data.length === 0) return null;

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["mcp"] });

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const signIn = (c: ConnectorView) =>
    run(c.id, async () => {
      showInfo(`Sign in to ${c.name} in your browser.`);
      const r = await ipc.signInAccountMcp({ id: c.id, appId });
      if (r.ok) showSuccess(r.enabled ? `${c.name} is on.` : `${c.name} is signed in.`);
      else showError(r.error ?? `Couldn't sign in to ${c.name}.`);
    });

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">On all your devices</div>
      {data.map((c) => {
        const needsSignIn = c.authType === "oauth" && !c.connected;
        const needsKey = (c.authType === "api_key" || c.authType === "header") && !c.connected;
        return (
          <div key={c.id} className="border rounded-lg p-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium truncate">{c.name}</div>
              <div className="text-xs text-muted-foreground truncate">
                {host(c.url)}
                {c.tools.length > 0 && ` · ${c.tools.length} tool${c.tools.length === 1 ? "" : "s"}`}
                {c.lastError && <span className="text-destructive"> · {c.lastError}</span>}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {busy === c.id && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              {needsSignIn && (
                <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void signIn(c)}>
                  Sign in
                </Button>
              )}
              {needsKey && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy != null}
                  onClick={() =>
                    void finish([
                      {
                        where: "account",
                        id: c.id,
                        name: c.name,
                        enabled: false,
                        needsSignIn: false,
                        needsSecret: { header: c.authHeader },
                      },
                    ])
                  }
                >
                  Add key
                </Button>
              )}
              <Switch
                checked={c.enabled}
                disabled={busy != null || needsSignIn || needsKey}
                onCheckedChange={(on) =>
                  void run(c.id, () => ipc.setAccountMcpEnabled({ id: c.id, enabled: on, appId }))
                }
                aria-label={`${c.name} on`}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={busy != null}
                onClick={() => void run(c.id, () => ipc.removeAccountMcp(c.id))}
              >
                Remove
              </Button>
            </div>
          </div>
        );
      })}
      {dialog}
    </div>
  );
}
