import { useCallback, useEffect, useState } from "react";
import { IpcClient, type UpdateStatusPayload } from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  RefreshCw,
  Download,
  CheckCircle2,
  AlertTriangle,
  Info,
} from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { showError } from "@/lib/toast";

const RESULT_LABEL: Record<UpdateStatusPayload["lastResult"], string> = {
  idle: "Not checked yet",
  checking: "Checking…",
  "up-to-date": "Up to date",
  available: "Update available",
  downloading: "Downloading…",
  downloaded: "Ready to install",
  error: "Last check failed",
  unsupported: "Automatic updates unavailable",
};

function formatWhen(ts: number | null): string {
  if (!ts) return "never";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "unknown";
  }
}

function StatusIcon({ result }: { result: UpdateStatusPayload["lastResult"] }) {
  if (result === "downloaded" || result === "available")
    return <Download className="w-4 h-4 text-primary" />;
  if (result === "error")
    return <AlertTriangle className="w-4 h-4 text-destructive" />;
  if (result === "unsupported")
    return <Info className="w-4 h-4 text-muted-foreground" />;
  if (result === "up-to-date")
    return <CheckCircle2 className="w-4 h-4 text-green-500" />;
  return <RefreshCw className="w-4 h-4 text-muted-foreground" />;
}

/**
 * Update diagnostics — surfaces the auto-updater state that was previously
 * invisible (errors used to be swallowed). Shows the current version, the last
 * check + result/detail, a manual "Check now", and a one-click install when an
 * update has downloaded.
 */
export function UpdateDiagnostics() {
  const { settings, updateSettings } = useSettings();
  const [status, setStatus] = useState<UpdateStatusPayload | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let alive = true;
    void IpcClient.getInstance()
      .getUpdateStatus()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {});
    const unsub = IpcClient.getInstance().onUpdateStatus((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const handleCheckNow = useCallback(async () => {
    setChecking(true);
    try {
      const s = await IpcClient.getInstance().checkForUpdatesNow();
      setStatus(s);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Update check failed");
    } finally {
      setChecking(false);
    }
  }, []);

  const result = status?.lastResult ?? "idle";
  const autoUpdateOn = settings?.enableAutoUpdate ?? true;

  return (
    <div className="pt-4 border-t border-border mt-4 space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <label
            htmlFor="enable-auto-update"
            className="text-sm font-medium text-foreground"
          >
            Automatic updates
          </label>
          <p className="text-xs text-muted-foreground">
            Download new versions in the background and install on restart.
          </p>
        </div>
        <Switch
          id="enable-auto-update"
          checked={autoUpdateOn}
          onCheckedChange={(checked) => {
            updateSettings({ enableAutoUpdate: checked });
          }}
        />
      </div>

      <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1.5">
        <div className="flex items-center gap-2 text-sm text-foreground">
          <StatusIcon result={result} />
          <span className="font-medium">{RESULT_LABEL[result]}</span>
          {status?.availableVersion && result !== "up-to-date" ? (
            <span className="font-mono text-xs text-muted-foreground">
              v{status.availableVersion}
            </span>
          ) : null}
        </div>
        {status?.detail ? (
          <p className="text-xs text-muted-foreground">{status.detail}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Last checked: {formatWhen(status?.lastCheckAt ?? null)}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleCheckNow}
          disabled={checking || result === "checking"}
        >
          <RefreshCw
            className={`w-3.5 h-3.5 mr-1.5 ${checking ? "animate-spin" : ""}`}
          />
          Check for updates now
        </Button>
        {result === "downloaded" ? (
          <Button
            size="sm"
            onClick={() => IpcClient.getInstance().installUpdateNow()}
          >
            Restart &amp; install
          </Button>
        ) : null}
      </div>
    </div>
  );
}
