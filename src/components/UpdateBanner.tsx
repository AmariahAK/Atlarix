import { useState, useEffect } from "react";
import { IpcClient } from "@/ipc/ipc_client";
import { X, Download, RefreshCw } from "lucide-react";

/**
 * UpdateBanner
 * ============
 * - Shows a subtle "Downloading update…" strip when update:downloading fires.
 * - Replaces the strip with a "Restart Now / Remind me later" banner when update:downloaded fires.
 * - "Remind me later" writes a defer flag via IPC so the update installs on next cold start.
 * - Dismiss (×) without deferring just hides the banner for the session via localStorage.
 */
export function UpdateBanner() {
  const [downloadingVersion, setDownloadingVersion] = useState<string | null>(null);
  const [downloadedVersion, setDownloadedVersion] = useState<string | null>(null);

  useEffect(() => {
    const unsub1 = IpcClient.getInstance().onUpdateDownloading(({ version }) => {
      setDownloadingVersion(version);
    });
    const unsub2 = IpcClient.getInstance().onUpdateDownloaded(({ version }) => {
      setDownloadingVersion(null);
      const key = `atlarix_update_banner_dismissed_${version}`;
      if (!localStorage.getItem(key)) {
        setDownloadedVersion(version);
      }
    });
    return () => {
      unsub1();
      unsub2();
    };
  }, []);

  // Subtle download-in-progress indicator
  if (downloadingVersion && !downloadedVersion) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground bg-muted/40 border-b border-border shrink-0">
        <Download className="w-3 h-3 animate-pulse shrink-0" />
        <span>Downloading update {downloadingVersion}…</span>
      </div>
    );
  }

  // Ready-to-install banner
  if (!downloadedVersion) return null;

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm bg-primary/10 border-b border-primary/20 shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <RefreshCw className="w-4 h-4 text-primary shrink-0" />
        <span className="text-foreground font-medium truncate">
          Atlarix {downloadedVersion} is ready to install
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => IpcClient.getInstance().installUpdateNow()}
          className="text-xs px-3 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium"
        >
          Restart Now
        </button>
        <button
          type="button"
          onClick={() => {
            localStorage.setItem(`atlarix_update_banner_dismissed_${downloadedVersion}`, "1");
            IpcClient.getInstance().deferUpdate().catch(() => {});
            setDownloadedVersion(null);
          }}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Remind me later
        </button>
        <button
          type="button"
          aria-label="Dismiss update banner"
          onClick={() => {
            localStorage.setItem(`atlarix_update_banner_dismissed_${downloadedVersion}`, "1");
            setDownloadedVersion(null);
          }}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
