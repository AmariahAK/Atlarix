import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Plug, ShieldCheck } from "lucide-react";
import { showError, showSuccess } from "@/lib/toast";

interface WorkspacePermissionsPanelProps {
  chatId?: number;
  requestId?: string;
  services: string[];
  alreadyConnected?: string[];
  message?: string;
}

type ConnectedService = {
  name: string;
};

export function WorkspacePermissionsPanel({
  chatId,
  requestId,
  services,
  alreadyConnected = [],
  message,
}: WorkspacePermissionsPanelProps) {
  const [connected, setConnected] = useState<string[]>(alreadyConnected);
  const [loading, setLoading] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refreshConnected = useCallback(async () => {
    const ipc = window.electron?.ipcRenderer;
    if (!ipc?.invoke) return;
    setLoading(true);
    try {
      const rows = (await ipc.invoke("token-vault:list-services")) as ConnectedService[];
      const names = Array.isArray(rows) ? rows.map((r) => String(r.name).toLowerCase()) : [];
      setConnected(names);
    } catch {
      setConnected((prev) => prev);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshConnected();
    const unsub = window.electron?.ipcRenderer?.on?.("token-vault:connected", () => {
      void refreshConnected();
    });
    return () => {
      unsub?.();
    };
  }, [refreshConnected]);

  const normalizedRequested = useMemo(
    () => Array.from(new Set(services.map((s) => s.toLowerCase()).filter(Boolean))),
    [services],
  );
  const connectedSet = useMemo(() => new Set(connected), [connected]);
  const pending = normalizedRequested.filter((s) => !connectedSet.has(s));

  const handleConnect = async (service: string) => {
    const ipc = window.electron?.ipcRenderer;
    if (!ipc?.invoke) return;
    setConnecting(service);
    try {
      const result = (await ipc.invoke("token-vault:start-connect", service)) as {
        success?: boolean;
        error?: string;
      };
      if (result?.success) {
        showSuccess(`Opened ${service} sign-in in your browser.`);
      } else {
        showError(result?.error ?? `Failed to start ${service} connect flow`);
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : `Failed to start ${service} connect flow`);
    } finally {
      setConnecting(null);
      setTimeout(() => void refreshConnected(), 1000);
    }
  };

  const handleDone = async () => {
    if (!chatId || !requestId) return;
    const ipc = window.electron?.ipcRenderer;
    if (!ipc?.invoke) return;
    setSubmitting(true);
    try {
      await ipc.invoke("respond-workspace-permissions", {
        chatId,
        requestId,
        dismissed: true,
        grantedServices: normalizedRequested.filter((s) => connectedSet.has(s)),
      });
      showSuccess("Workspace permissions submitted.");
    } catch (e) {
      showError(e instanceof Error ? e.message : "Failed to submit workspace permissions");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-start gap-2">
        <ShieldCheck className="h-5 w-5 text-primary mt-0.5" />
        <div>
          <h3 className="text-sm font-semibold">Workspace permissions required</h3>
          <p className="text-xs text-muted-foreground">
            {message ?? "Connect the requested services for this turn, then click Done."}
          </p>
        </div>
      </div>

      {loading ? (
        <div className="text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading connected services...
        </div>
      ) : null}

      <div className="space-y-2">
        {normalizedRequested.length === 0 ? (
          <p className="text-xs text-muted-foreground">No additional services required.</p>
        ) : (
          normalizedRequested.map((service) => {
            const isConnected = connectedSet.has(service);
            return (
              <div
                key={service}
                className="flex items-center justify-between rounded-md border border-border p-2 bg-background"
              >
                <div className="flex items-center gap-2">
                  <Plug className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium capitalize">{service.replace(/_/g, " ")}</span>
                  {isConnected ? (
                    <span className="text-[11px] text-green-600 dark:text-green-400">Connected</span>
                  ) : (
                    <span className="text-[11px] text-amber-600 dark:text-amber-400">Not connected</span>
                  )}
                </div>
                <Button
                  size="sm"
                  variant={isConnected ? "outline" : "default"}
                  disabled={isConnected || connecting !== null}
                  onClick={() => void handleConnect(service)}
                >
                  {connecting === service ? "Opening..." : isConnected ? "Ready" : "Connect"}
                </Button>
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between pt-1">
        <p className="text-xs text-muted-foreground">
          {pending.length === 0
            ? "All requested services are connected."
            : `${pending.length} service(s) still pending: ${pending.join(", ")}`}
        </p>
        <Button size="sm" onClick={() => void handleDone()} disabled={submitting}>
          {submitting ? "Submitting..." : "Done"}
        </Button>
      </div>
    </div>
  );
}
