import { useCallback, useEffect, useState } from "react";
import { IpcClient } from "@/ipc/ipc_client";

/**
 * Dev-only floating overlay: recent tool durations from main-process ring buffer.
 * Toggle: **Ctrl+Shift+Alt+P** when the app is not packaged.
 */
export function PerfDevOverlayHost() {
  const [enabled, setEnabled] = useState(false);
  const [packaged, setPackaged] = useState(true);
  const [snapshot, setSnapshot] = useState<{ name: string; ms: number; at: number }[]>([]);

  useEffect(() => {
    let cancelled = false;
    void IpcClient.getInstance()
      .getSentryConfig()
      .then((c) => {
        if (!cancelled) setPackaged(c.isPackaged);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const rows = await IpcClient.getInstance().getToolPerfSnapshot();
      setSnapshot(rows);
    } catch {
      setSnapshot([]);
    }
  }, []);

  useEffect(() => {
    if (!enabled || packaged) return;
    void refresh();
    const id = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(id);
  }, [enabled, packaged, refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (packaged) return;
      if (e.ctrlKey && e.shiftKey && e.altKey && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        setEnabled((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [packaged]);

  if (packaged || !enabled) return null;

  return (
    <div
      className="fixed bottom-3 right-3 z-9999 max-w-sm rounded-md border border-border bg-background/95 p-3 text-[11px] shadow-lg backdrop-blur-sm"
      data-testid="perf-dev-overlay"
    >
      <div className="mb-2 flex items-center justify-between gap-2 font-semibold text-foreground">
        <span>/perf — recent tools</span>
        <button
          type="button"
          className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-muted"
          onClick={() => setEnabled(false)}
        >
          Close
        </button>
      </div>
      <p className="mb-2 text-muted-foreground">Ctrl+Shift+Alt+P toggles. Data from main process only.</p>
      <ul className="max-h-48 space-y-1 overflow-y-auto font-mono text-[10px]">
        {snapshot.length === 0 ? (
          <li className="text-muted-foreground">No tool timings yet.</li>
        ) : (
          [...snapshot]
            .reverse()
            .map((row, i) => (
              <li key={`${row.at}-${i}`} className="flex justify-between gap-2">
                <span className="truncate text-foreground">{row.name}</span>
                <span className="shrink-0 text-muted-foreground">{row.ms}ms</span>
              </li>
            ))
        )}
      </ul>
    </div>
  );
}
