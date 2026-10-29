import { useState, useEffect, useRef } from "react";
import { IpcClient } from "@/ipc/ipc_client";
import { X, Download, RefreshCw, ExternalLink } from "lucide-react";

const DOWNLOAD_PAGE = "https://atlarix.dev";

/**
 * UpdateBanner
 * ============
 * - Notify-only strip when a newer GitHub release exists (update:available).
 * - Download progress + ready-to-install for electron-updater (update:downloading / update:downloaded).
 * - A failed download or install (update:status "error") clears both; the main
 *   process checks again soon (2026-10-26: a download that died stayed on
 *   "Downloading…").
 */
export function UpdateBanner() {
  const [downloadingVersion, setDownloadingVersion] = useState<string | null>(
    null,
  );
  const [downloadedVersion, setDownloadedVersion] = useState<string | null>(
    null,
  );
  const [notifyUpdate, setNotifyUpdate] = useState<{
    latestVersion: string;
    releaseUrl: string;
  } | null>(null);
  const notifyDismissedRef = useRef(false);
  const [failed, setFailed] = useState(false);
  // The update this window is showing (downloading or ready), read by the status
  // listener: an error from a background check with nothing on screen stays quiet.
  const showingRef = useRef(false);
  useEffect(() => {
    showingRef.current = downloadingVersion != null || downloadedVersion != null;
  }, [downloadingVersion, downloadedVersion]);

  useEffect(() => {
    const unsub1 = IpcClient.getInstance().onUpdateDownloading(
      ({ version }) => {
        showingRef.current = true; // before the effect: a failure can follow at once
        setFailed(false);
        setDownloadingVersion(version);
      },
    );
    const unsub2 = IpcClient.getInstance().onUpdateDownloaded(({ version }) => {
      setFailed(false);
      setDownloadingVersion(null);
      const key = `atlarix_update_banner_dismissed_${version}`;
      if (!localStorage.getItem(key)) {
        showingRef.current = true;
        setDownloadedVersion(version);
      }
    });
    const unsub4 = IpcClient.getInstance().onUpdateStatus(({ lastResult }) => {
      if (lastResult !== "error" || !showingRef.current) return;
      setDownloadingVersion(null);
      setDownloadedVersion(null);
      setFailed(true);
    });
    const unsub3 = IpcClient.getInstance().onUpdateAvailable(
      ({ latestVersion, releaseUrl }) => {
        if (!notifyDismissedRef.current) {
          setNotifyUpdate({ latestVersion, releaseUrl });
        }
      },
    );
    return () => {
      unsub1();
      unsub2();
      unsub3();
      unsub4();
    };
  }, []);

  if (notifyUpdate && !downloadedVersion && !downloadingVersion) {
    return (
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm bg-muted/60 border-b border-border shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Download className="w-4 h-4 text-primary shrink-0" />
          <span className="text-foreground truncate">
            Atlarix {notifyUpdate.latestVersion} is available
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              void IpcClient.getInstance().openExternalUrl(DOWNLOAD_PAGE);
            }}
            className="flex items-center gap-1 text-xs px-3 py-1 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium"
          >
            Download update
            <ExternalLink className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => {
              notifyDismissedRef.current = true;
              setNotifyUpdate(null);
            }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Dismiss
          </button>
          <button
            type="button"
            aria-label="Dismiss update banner"
            onClick={() => {
              notifyDismissedRef.current = true;
              setNotifyUpdate(null);
            }}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    );
  }

  if (failed && !downloadingVersion && !downloadedVersion) {
    return (
      <div className="flex items-center justify-between gap-2 px-4 py-2 text-xs text-muted-foreground bg-muted/40 border-b border-border shrink-0">
        <span>Update failed. Retrying soon.</span>
        <button
          type="button"
          aria-label="Dismiss update banner"
          onClick={() => setFailed(false)}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }

  if (downloadingVersion && !downloadedVersion) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground bg-muted/40 border-b border-border shrink-0">
        <Download className="w-3 h-3 animate-pulse shrink-0" />
        <span>Downloading update {downloadingVersion}…</span>
      </div>
    );
  }

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
            localStorage.setItem(
              `atlarix_update_banner_dismissed_${downloadedVersion}`,
              "1",
            );
            IpcClient.getInstance()
              .deferUpdate()
              .catch(() => {});
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
            localStorage.setItem(
              `atlarix_update_banner_dismissed_${downloadedVersion}`,
              "1",
            );
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
