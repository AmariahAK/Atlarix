/**
 * Left Panel — Tabbed extension panels (max 5). Mirrors right panel, for extensions.
 * Resizable via drag handle on the right edge; width persisted in localStorage (atlarix-left-panel-width).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { useAtomValue, useSetAtom, useAtom } from "jotai";
import { activeExtensionIdsAtom, selectedExtensionIdAtom } from "@/atoms/viewAtoms";
import { currentAppAtom } from "@/atoms/appAtoms";
import { leftPanelWidthAtom } from "@/atoms/sourceAtoms";
import { getExtensionById } from "@/lib/extensions/extension-registry";
import { Database, Workflow, Github, MessageCircle, CheckSquare, ScrollText, X } from "lucide-react";
import { cn } from "@/lib/utils";

const LEFT_PANEL_STORAGE_KEY = "atlarix-left-panel-width";
const MIN_WIDTH = 200;
const DEFAULT_WIDTH = 280;

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Database,
  Workflow,
  Github,
  MessageCircle,
  CheckSquare,
  ScrollText,
};

const MAX_TABS = 5;

export function LeftPanel() {
  const activeIds = useAtomValue(activeExtensionIdsAtom);
  const selectedId = useAtomValue(selectedExtensionIdAtom);
  const setSelectedId = useSetAtom(selectedExtensionIdAtom);
  const setActiveIds = useSetAtom(activeExtensionIdsAtom);
  const currentApp = useAtomValue(currentAppAtom);
  const workspaceId = currentApp?.id ?? null;
  const [width, setWidth] = useAtom(leftPanelWidthAtom);

  const [PanelComponent, setPanelComponent] = useState<React.ComponentType<{ workspaceId: number | null }> | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const selectedExt = selectedId ? getExtensionById(selectedId) : null;

  // Hydrate width from localStorage on mount
  useEffect(() => {
    try {
      const s = localStorage.getItem(LEFT_PANEL_STORAGE_KEY);
      if (s) {
        const n = parseInt(s, 10);
        if (!Number.isNaN(n) && n >= MIN_WIDTH) setWidth(n);
      }
    } catch {
      // ignore
    }
  }, [setWidth]);

  useEffect(() => {
    if (!selectedExt) {
      setPanelComponent(null);
      return;
    }
    setPanelLoading(true);
    selectedExt.getPanelComponent().then((Comp) => {
      setPanelComponent(() => Comp);
      setPanelLoading(false);
    }).catch(() => setPanelLoading(false));
  }, [selectedExt?.id]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!panelRef.current) return;
      const newWidth = e.clientX;
      const maxW = Math.floor(window.innerWidth * 0.6);
      const w = Math.max(MIN_WIDTH, Math.min(maxW, newWidth));
      setWidth(w);
      try {
        localStorage.setItem(LEFT_PANEL_STORAGE_KEY, String(w));
      } catch {
        // ignore
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, setWidth]);

  const removeTab = (id: string) => {
    const next = activeIds.filter((e) => e !== id);
    setActiveIds(next);
    if (selectedId === id) setSelectedId(next[0] ?? null);
  };

  return (
    <div
      ref={panelRef}
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-border bg-background relative",
        !isDragging && "animate-slide-in-right"
      )}
      style={{
        width: `${width}px`,
        minWidth: MIN_WIDTH,
        maxWidth: "60vw",
      }}
    >
      {isDragging && (
        <div
          className="fixed inset-0 z-[9999] cursor-col-resize user-select-none"
          style={{ touchAction: "none" }}
          aria-hidden
        />
      )}
      <div
        role="separator"
        aria-label="Resize left panel"
        onMouseDown={handleMouseDown}
        className={cn(
          "absolute right-0 top-0 bottom-0 w-3 -mr-1.5 cursor-col-resize z-50",
          "hover:bg-primary/30 transition-colors",
          isDragging && "bg-primary/50"
        )}
        style={{ touchAction: "none" }}
      />
      <div className="flex border-b border-border">
        {activeIds.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground border-b-2 border-transparent">
            Extensions
          </div>
        ) : activeIds.map((id) => {
          const ext = getExtensionById(id);
          if (!ext) return null;
          const Icon = ICON_MAP[ext.icon] ?? Database;
          const isSelected = selectedId === id;
          return (
            <div
              key={id}
              className={cn(
                "flex items-center gap-1.5 px-2 py-2 border-b-2 min-w-0",
                isSelected ? "border-primary bg-muted/30" : "border-transparent hover:bg-muted/20"
              )}
            >
              <button
                type="button"
                onClick={() => setSelectedId(id)}
                className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
              >
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-xs font-medium truncate">{ext.name}</span>
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); removeTab(id); }}
                className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                aria-label="Close tab"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeIds.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground text-center">
            Add an extension in <strong>Settings → Extensions</strong> to use the left panel.
          </div>
        ) : panelLoading ? (
          <div className="p-4 text-sm text-muted-foreground">Loading…</div>
        ) : PanelComponent ? (
          <PanelComponent workspaceId={workspaceId} />
        ) : (
          <div className="p-4 text-sm text-muted-foreground">Select an extension.</div>
        )}
      </div>
    </div>
  );
}
