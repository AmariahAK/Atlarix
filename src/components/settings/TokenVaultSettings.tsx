/**
 * Token Vault / Connected services UI — Workforce
 * Connect Slack, Jira, Linear via Auth0; disconnect. Service scope for AI is chosen per chat session when tools run.
 */

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { showError, showSuccess } from "@/lib/toast";
import { Plug, Loader2 } from "lucide-react";

const SUPPORTED_SERVICES = [
  { id: "slack", label: "Slack" },
  { id: "jira", label: "Jira" },
  { id: "linear", label: "Linear" },
] as const;

interface ConnectedService {
  name: string;
  scopes: string[];
  connectedAt: string;
  expiresAt: string | null;
}

function getInvoke(): ((channel: string, ...args: unknown[]) => Promise<unknown>) | null {
  return (window as unknown as { electron?: { ipcRenderer?: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } } })
    .electron?.ipcRenderer?.invoke ?? null;
}

interface TokenVaultSettingsProps {
  workspaceId?: number | string | null;
}

export function TokenVaultSettings({ workspaceId = null }: TokenVaultSettingsProps) {
  const [connected, setConnected] = useState<ConnectedService[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [spaceJson, setSpaceJson] = useState<string>("");
  const [spaceSaving, setSpaceSaving] = useState(false);

  const fetchConnected = useCallback(async () => {
    const invoke = getInvoke();
    if (!invoke) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = (await invoke("token-vault:list-services")) as ConnectedService[];
      setConnected(Array.isArray(list) ? list : []);
    } catch {
      setConnected([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSpace = useCallback(async () => {
    const invoke = getInvoke();
    if (!invoke) return;
    try {
      const res = (await invoke("extensions:get-all-space-selections", workspaceId)) as { selections: Record<string, unknown> };
      setSpaceJson(JSON.stringify(res?.selections ?? {}, null, 2));
    } catch {
      setSpaceJson("{}");
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchConnected();
    fetchSpace();
  }, [fetchConnected, fetchSpace]);

  useEffect(() => {
    const ipc = (window as unknown as { electron?: { ipcRenderer?: { on: (c: string, fn: () => void) => void; removeListener?: (c: string, fn: () => void) => void } } }).electron?.ipcRenderer;
    if (!ipc?.on) return;
    const onConnected = () => fetchConnected();
    ipc.on("token-vault:connected", onConnected);
    return () => {
      if (typeof ipc.removeListener === "function") ipc.removeListener("token-vault:connected", onConnected);
    };
  }, [fetchConnected]);

  const handleConnect = async (service: string) => {
    const invoke = getInvoke();
    if (!invoke) return;
    setConnecting(service);
    try {
      const res = (await invoke("token-vault:start-connect", service)) as { success?: boolean; error?: string };
      if (res?.success) {
        showSuccess(`Open the browser to connect ${service}. After connecting, refresh this list.`);
        setTimeout(() => fetchConnected(), 3000);
      } else {
        showError(res?.error ?? "Could not start connect flow");
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : "Connect failed");
    } finally {
      setConnecting(null);
    }
  };

  const handleDisconnect = async (service: string) => {
    const invoke = getInvoke();
    if (!invoke || !window.confirm(`Disconnect ${service}?`)) return;
    setRevoking(service);
    try {
      await invoke("token-vault:revoke", service);
      showSuccess(`${service} disconnected.`);
      await fetchConnected();
    } catch (e) {
      showError(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setRevoking(null);
    }
  };

  const handleSaveSpace = async () => {
    const invoke = getInvoke();
    if (!invoke) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(spaceJson) as Record<string, unknown>;
    } catch {
      showError("Invalid JSON");
      return;
    }
    setSpaceSaving(true);
    try {
      for (const [service, selection] of Object.entries(parsed)) {
        await invoke(
          "extensions:set-space-selection",
          workspaceId,
          service,
          selection != null && typeof selection === "object" ? (selection as Record<string, unknown>) : null
        );
      }
      showSuccess("Space selection saved.");
    } catch (e) {
      showError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSpaceSaving(false);
    }
  };

  const connectedNames = new Set(connected.map((c) => c.name.toLowerCase()));

  return (
    <div className="mt-6 space-y-4">
      <h3 className="text-sm font-medium text-foreground">Connected services (Token Vault)</h3>
      <p className="text-xs text-muted-foreground">
        Connect Slack, Jira, or Linear so the AI can read and act on your behalf. You can choose which channels or projects the AI can see per workspace below.
      </p>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      ) : (
        <div className="space-y-2">
          {SUPPORTED_SERVICES.map(({ id, label }) => {
            const isConnected = connectedNames.has(id);
            return (
              <div
                key={id}
                className="flex items-center justify-between gap-4 py-2 px-3 rounded-lg border border-border bg-muted/20"
              >
                <div className="flex items-center gap-2">
                  <Plug className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{label}</span>
                  {isConnected && (
                    <span className="text-xs text-green-600 dark:text-green-400">Connected</span>
                  )}
                </div>
                {isConnected ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDisconnect(id)}
                    disabled={revoking === id}
                  >
                    {revoking === id ? "Disconnecting…" : "Disconnect"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => handleConnect(id)}
                    disabled={connecting !== null}
                  >
                    {connecting === id ? "Opening…" : "Connect"}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="pt-2">
        <h4 className="text-sm font-medium text-foreground mb-1">Space selection (this workspace)</h4>
        <p className="text-xs text-muted-foreground mb-2">
          Optional: restrict which Slack channels or Jira projects the AI can see. Example: {`{ "slack": { "channel_ids": ["C123"] }, "jira": { "project_keys": ["PROJ"] } }`}
        </p>
        <textarea
          className="w-full min-h-[80px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
          value={spaceJson}
          onChange={(e) => setSpaceJson(e.target.value)}
          placeholder='{}'
        />
        <Button size="sm" variant="outline" className="mt-2" onClick={handleSaveSpace} disabled={spaceSaving}>
          {spaceSaving ? "Saving…" : "Save space selection"}
        </Button>
      </div>
    </div>
  );
}
