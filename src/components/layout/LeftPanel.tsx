/**
 * Left Panel — Tabbed extension panels (max 5). Mirrors right panel, for extensions.
 */

import { useState, useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { activeExtensionIdsAtom, selectedExtensionIdAtom } from "@/atoms/viewAtoms";
import { currentAppAtom } from "@/atoms/appAtoms";
import { getExtensionById } from "@/lib/extensions/extension-registry";
import { Database, Workflow, Github, MessageCircle, CheckSquare, ScrollText, X } from "lucide-react";
import { cn } from "@/lib/utils";

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

  const [PanelComponent, setPanelComponent] = useState<React.ComponentType<{ workspaceId: number | null }> | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);

  const selectedExt = selectedId ? getExtensionById(selectedId) : null;

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

  if (activeIds.length === 0) return null;

  const removeTab = (id: string) => {
    const next = activeIds.filter((e) => e !== id);
    setActiveIds(next);
    if (selectedId === id) setSelectedId(next[0] ?? null);
  };

  return (
    <div className="flex h-full w-[280px] shrink-0 flex-col border-r border-border bg-background">
      <div className="flex border-b border-border">
        {activeIds.map((id) => {
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
        {panelLoading ? (
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
