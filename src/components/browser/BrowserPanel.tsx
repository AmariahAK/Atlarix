/**
 * In-app browser panel (v11) — chrome (URL bar, nav buttons, tab strip) for
 * the main-process WebContentsView, which renders natively OVER the rect this
 * component reports via browser:set-bounds. The placeholder div below is the
 * view's footprint; keep it empty.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Plus,
  RotateCw,
  X,
} from "lucide-react";
import { IpcClient } from "@/ipc/ipc_client";
import type { BrowserPanelState } from "@/ipc/utils/browser_view_manager";
import { cn } from "@/lib/utils";

export function BrowserPanel() {
  const [state, setState] = useState<BrowserPanelState | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [urlFocused, setUrlFocused] = useState(false);
  const placeholderRef = useRef<HTMLDivElement | null>(null);

  const activeTab =
    state?.tabs.find((t) => t.id === state.activeTabId) ?? state?.tabs[0] ?? null;

  // Reflect the active tab's URL in the bar unless the user is editing it.
  useEffect(() => {
    if (!urlFocused && activeTab) setUrlInput(activeTab.url);
  }, [activeTab?.url, urlFocused, activeTab]);

  const reportBounds = useCallback(() => {
    const el = placeholderRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    void IpcClient.getInstance().browserSetBounds({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }, []);

  // Lifecycle: show the WebContentsView while mounted, hide on unmount.
  useEffect(() => {
    const ipc = IpcClient.getInstance();
    let disposed = false;
    void ipc.browserSetVisible(true).then((s: BrowserPanelState) => {
      if (!disposed) setState(s);
      reportBounds();
    });
    const off = ipc.onBrowserStateChanged((s) => {
      if (!disposed) setState(s);
    });
    const el = placeholderRef.current;
    const observer = new ResizeObserver(() => reportBounds());
    if (el) observer.observe(el);
    window.addEventListener("resize", reportBounds);
    // Layout can shift after mount (panel animations) — re-report shortly after.
    const settle = setTimeout(reportBounds, 250);
    return () => {
      disposed = true;
      clearTimeout(settle);
      observer.disconnect();
      window.removeEventListener("resize", reportBounds);
      off();
      void ipc.browserSetVisible(false);
    };
  }, [reportBounds]);

  const submitUrl = async () => {
    const ipc = IpcClient.getInstance();
    const result = await ipc.browserNavigate(urlInput);
    if (!result.ok && result.error) {
      setUrlInput(activeTab?.url ?? "");
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Tab strip */}
      <div className="flex items-center gap-1 border-b border-border px-1.5 pt-1.5">
        {(state?.tabs ?? []).map((tab) => (
          <button
            key={tab.id}
            onClick={() => void IpcClient.getInstance().browserSetActiveTab(tab.id)}
            className={cn(
              "group flex max-w-44 items-center gap-1.5 rounded-t-md px-2.5 py-1 text-xs",
              tab.id === state?.activeTabId
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/50",
            )}
            title={tab.url}
          >
            <Globe className="h-3 w-3 shrink-0" />
            <span className="truncate">{tab.title || tab.url || "New tab"}</span>
            <X
              className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-70 hover:!opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                void IpcClient.getInstance().browserCloseTab(tab.id);
              }}
            />
          </button>
        ))}
        <button
          onClick={() => void IpcClient.getInstance().browserCreateTab()}
          className="rounded p-1 text-muted-foreground hover:bg-muted/50"
          title="New tab"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Nav bar */}
      <div className="flex items-center gap-1 border-b border-border px-1.5 py-1.5">
        <button
          onClick={() => void IpcClient.getInstance().browserBack()}
          disabled={!activeTab?.canGoBack}
          className="rounded p-1 text-muted-foreground enabled:hover:bg-muted/50 disabled:opacity-30"
          title="Back"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => void IpcClient.getInstance().browserForward()}
          disabled={!activeTab?.canGoForward}
          className="rounded p-1 text-muted-foreground enabled:hover:bg-muted/50 disabled:opacity-30"
          title="Forward"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => void IpcClient.getInstance().browserReload()}
          className={cn(
            "rounded p-1 text-muted-foreground hover:bg-muted/50",
            activeTab?.loading && "animate-spin",
          )}
          title="Reload"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onFocus={(e) => {
            setUrlFocused(true);
            e.currentTarget.select();
          }}
          onBlur={() => setUrlFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void submitUrl();
              e.currentTarget.blur();
            }
          }}
          placeholder="Enter a URL (https://…)"
          spellCheck={false}
          className="ml-1 h-7 flex-1 rounded-md border border-border bg-background px-2.5 font-mono text-xs text-foreground outline-none focus:border-ring"
        />
      </div>

      {/* WebContentsView footprint — the native view renders over this rect. */}
      <div ref={placeholderRef} className="min-h-0 flex-1 bg-background" />
    </div>
  );
}
