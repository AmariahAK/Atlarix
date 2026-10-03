/**
 * RightPanel - Master Panel Router
 * =================================
 * Context-aware right panel that dynamically adapts based on current activity
 *
 * Panel Types:
 * - web-search: Source cards + iframe preview
 * - code-preview: Live preview iframe (frontend)
 * - terminal: Command output
 * - empty: No content
 */

import React from "react";
import { useRightPanelContext } from "@/hooks/useRightPanelContext";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  automationsFocusRunIdAtom,
  automationsUnreadCountAtom,
} from "@/atoms/automationAtoms";
import { AutomationsTab } from "./automations/AutomationsTab";
import { RelicsTab } from "./relics/RelicsTab";
import { IpcClient } from "@/ipc/ipc_client";
import { useSearch } from "@tanstack/react-router";
import {
  rightPanelVisibleAtom,
  rightPanelWidthAtom,
  pinnedPanelAtom,
  rightPanelSuppressAutoOpenAtom,
  planUnreadAtom,
} from "@/atoms/sourceAtoms";
import SourcePreviewPanel from "./preview_panel/SourcePreviewPanel";
import CodePreviewPanel from "./preview_panel/CodePreviewPanel";
import { EmbeddedChatTab } from "./panels/EmbeddedChatTab";
import { cn } from "@/lib/utils";
import {
  X,
  Terminal,
  Wrench,
  Search,
  Eye,
  Shield,
  Globe,
  Code2,
  FileText,
  MessageSquare,
  ListTree,
  AlarmClock,
  Sparkles,
} from "lucide-react";
import { TerminalPanel } from "./panels/TerminalPanel";
import { ToolCallCard, ToolStatus } from "./ToolCallCard";
import { useRef, useEffect, useState, useCallback } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { type PanelTab } from "@/atoms/sourceAtoms";
import { useWorkspacePlanPanel } from "@/hooks/useWorkspacePlanPanel";
import { PlanExecutionPanel } from "@/components/preview_panel/PlanExecutionPanel";

// Icon configuration for secondary tabs
const TAB_ICONS: Record<PanelTab, { icon: React.ElementType; label: string }> =
  {
    preview: { icon: Eye, label: "Preview" },
    terminal: { icon: Terminal, label: "Terminal" },
    automations: { icon: AlarmClock, label: "Automations" },
    relics: { icon: Sparkles, label: "Relics" },
    permissions: { icon: Shield, label: "Permissions" },
    search: { icon: Globe, label: "Search" },
    sources: { icon: Globe, label: "Sources" },
    logs: { icon: FileText, label: "Logs" },
    files: { icon: FileText, label: "Files" },
    approve: { icon: Shield, label: "Approve" },
    permission: { icon: Shield, label: "Permission" },
    plan: { icon: ListTree, label: "Plan" },
    tools: { icon: Wrench, label: "Tools" },
    debug: { icon: Terminal, label: "Debug" },
    chat: { icon: MessageSquare, label: "Chat" },
  };

export function RightPanel() {
  // Mounts the plan-artifact listeners; the panel now renders as the 'plan'
  // tab inside PanelContent rather than taking over the whole panel.
  useWorkspacePlanPanel();
  const { context, setActiveTab } = useRightPanelContext();
  const automationsUnread = useAtomValue(automationsUnreadCountAtom);
  const [planUnread, setPlanUnread] = useAtom(planUnreadAtom);
  const setAutomationsFocusRunId = useSetAtom(automationsFocusRunIdAtom);
  // OS-notification click → open the automations feed at the run.
  useEffect(() => {
    return IpcClient.getInstance().onAutomationsFocusFeed(({ runId }) => {
      setActiveTab("automations");
      if (runId) setAutomationsFocusRunId(runId);
    });
    // setActiveTab identity is stable enough for this subscription's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [isVisible, setIsVisible] = useAtom(rightPanelVisibleAtom);
  // Reading the tab IS acknowledging it. Clearing while the panel is hidden
  // would drop the badge for something the user never saw, which is the one
  // way an unread count can lie.
  useEffect(() => {
    if (!isVisible) return;
    if (context.activeTab === "plan" && planUnread) setPlanUnread(false);
  }, [isVisible, context.activeTab, planUnread, setPlanUnread]);
  const setSuppressRightAutoOpen = useSetAtom(rightPanelSuppressAutoOpenAtom);
  const [width, setWidth] = useAtom(rightPanelWidthAtom);
  const [_pinnedPanel, _setPinnedPanel] = useAtom(pinnedPanelAtom);

  // Get chatId from URL route as fallback for PermissionQueuePanel
  let routeChatId: number | undefined;
  try {
    const searchParams = useSearch({ strict: false }) as unknown as
      | { id?: number | string }
      | undefined;
    const id = searchParams?.id;
    routeChatId = id !== undefined && id !== null ? Number(id) : undefined;
  } catch {
    // Not on chat route, that's fine
  }

  // Drag resize state
  const [isDragging, setIsDragging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Handle drag resize
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!panelRef.current) return;
      const containerRight = window.innerWidth;
      const newWidth = containerRight - e.clientX;
      // Clamp between min and max
      setWidth(Math.max(280, Math.min(700, newWidth)));
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

  // Don't render if not visible
  if (!isVisible) {
    return null;
  }

  return (
    <div
      ref={panelRef}
      data-tour="tour-activity-panel"
      className={cn(
        "relative flex flex-col h-full bg-background border-l border-border flex-none z-10",
        !isDragging && "animate-slide-in-right",
      )}
      style={{ width: `${width}px`, minWidth: "280px", maxWidth: "700px" }}
    >
      {/* Global Drag Overlay - Captures all mouse events during drag */}
      {isDragging && (
        <div
          className="fixed inset-0 z-[9999] cursor-col-resize user-select-none"
          style={{ touchAction: "none" }}
        />
      )}

      {/* Fix: Finding 2 — visible resize grip + discoverability (see layout onboarding highlight) */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              data-onboarding="panel-resize-grip"
              role="separator"
              aria-orientation="vertical"
              aria-label="Drag to resize panel"
              title="Drag to resize panel"
              onMouseDown={(e) => {
                try {
                  localStorage.setItem("atlarix_panel_resize_hint_shown", "1");
                } catch {
                  /* ignore */
                }
                handleMouseDown(e);
              }}
              className={cn(
                "absolute left-0 top-0 bottom-0 w-3 -ml-1.5 cursor-col-resize z-50 flex items-center justify-center",
                "hover:bg-primary/25 transition-colors group",
                isDragging && "bg-primary/50",
              )}
              style={{ touchAction: "none" }}
            >
              <span className="flex flex-col gap-0.5 pointer-events-none opacity-60 group-hover:opacity-100">
                <span className="w-0.5 h-1 rounded-full bg-muted-foreground/80 mx-auto" />
                <span className="w-0.5 h-1 rounded-full bg-muted-foreground/80 mx-auto" />
                <span className="w-0.5 h-1 rounded-full bg-muted-foreground/80 mx-auto" />
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="left" className="max-w-[14rem]">
            Drag to resize the panel. Tabs switch between Preview, Terminal, and
            more.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* Header with Close Button */}
      <div className="flex items-center justify-end px-3 py-2 border-b border-border">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => {
                  setSuppressRightAutoOpen(true);
                  setIsVisible(false);
                }}
                className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                <X className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Close panel</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Tab Navigation - Always visible */}
      {context.tabs.length > 0 && (
        <TooltipProvider>
          <div className="flex flex-nowrap items-center gap-1 px-3 py-2 border-b border-border/50 bg-muted/20 overflow-x-auto flex-shrink-0 min-w-0">
            {context.tabs
              .filter(
                (tab) =>
                  !["permissions", "permission", "approve"].includes(tab),
              )
              .map((tab) => {
                const tabConfig = TAB_ICONS[tab];
                const Icon = tabConfig?.icon || Code2;
                const label = tabConfig?.label || tab;
                // Same badge vocabulary as automations, for the same
                // reason: nothing blocks a turn any more, so a count the
                // user can act on — or ignore — is how they find out.
                const unread = tab === "automations" ? automationsUnread : 0;
                // Plan is a "there is one" dot, not a count: a session
                // has a plan or it doesn't, and restoring one no longer
                // seizes the panel to tell you.
                const badge =
                  tab === "plan"
                    ? planUnread
                      ? "•"
                      : null
                    : unread > 0
                      ? unread > 9
                        ? "9+"
                        : String(unread)
                      : null;
                return (
                  <Tooltip key={tab}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => setActiveTab(tab)}
                        aria-label={label}
                        className={cn(
                          "relative p-2 rounded-md transition-colors",
                          context.activeTab === tab
                            ? "bg-primary/15 text-primary"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted",
                        )}
                      >
                        <Icon size={16} />
                        {badge && (
                          <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-semibold leading-none text-primary-foreground">
                            {badge}
                          </span>
                        )}
                        <span className="sr-only">{label}</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{label}</TooltipContent>
                  </Tooltip>
                );
              })}
          </div>
        </TooltipProvider>
      )}

      {/* Panel Content - scrollable */}
      <div className="flex-1 overflow-auto min-h-0">
        <PanelContent
          context={context}
          setActiveTab={setActiveTab}
          fallbackChatId={routeChatId}
        />
      </div>
    </div>
  );
}

/**
 * Renders the appropriate panel content based on context type
 */
function PanelContent({
  context,
  setActiveTab: _setActiveTab,
  fallbackChatId: _fallbackChatId,
}: {
  context: ReturnType<typeof useRightPanelContext>["context"];
  setActiveTab?: (tab: import("@/atoms/sourceAtoms").PanelTab) => void;
  fallbackChatId?: number;
}) {
  // Chat tab (when chat area is hidden)
  if (context.activeTab === "chat") {
    return <EmbeddedChatTab />;
  }

  // v13.1: plan is a coexisting tab, not a takeover panel.
  if (context.activeTab === "plan") {
    return <PlanExecutionPanel />;
  }

  switch (context.type) {
    case "web-search":
      return (
        <SourcePreviewPanel data={context.data} activeTab={context.activeTab} />
      );

    case "code-preview":
      if (context.activeTab === "terminal") {
        return <TerminalPanel />;
      }
      if (context.activeTab === "relics") {
        return <RelicsTab />;
      }
      if (context.activeTab === "automations") {
        return (
          <AutomationsTab
            appId={
              (context.data as { appId?: number | null } | null)?.appId ?? null
            }
          />
        );
      }
      return (
        <CodePreviewPanel
          data={context.data}
          activeTab={context.activeTab}
        />
      );

    case "terminal":
      return <TerminalPanel />;

    case "tools":
      // Tool execution activity panel
      return <ToolsPanel data={context.data} />;

    default:
      return (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-6 text-center">
          <div className="w-16 h-16 mb-4 rounded-full bg-muted/50 flex items-center justify-center">
            <Search className="w-8 h-8 opacity-50" />
          </div>
          <h3 className="text-sm font-medium mb-2 text-foreground">
            No content yet
          </h3>
          <p className="text-xs max-w-[200px]">
            Use the toolbar above to switch between modes:
          </p>
          <ul className="text-xs mt-3 space-y-1 text-left">
            <li>
              <strong>Search</strong> - Web search results
            </li>
          </ul>
          <p className="text-xs mt-4 opacity-60">
            Content will appear here as you chat
          </p>
        </div>
      );
  }
}

/**
 * Tools Panel - Display tool execution activity
 * Used primarily for Ask mode to show tool calls and results
 */
function ToolsPanel({ data }: { data: any }) {
  const timeline = data?.timeline || [];

  if (timeline.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
        <Wrench className="w-12 h-12 mb-3 opacity-50" />
        <p className="text-sm font-medium">No Tool Activity</p>
        <p className="text-xs text-center mt-1">
          Tool calls and results will appear here
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Wrench className="w-4 h-4 text-teal-400" />
        <span className="text-sm font-medium">Tool Activity</span>
        <span className="ml-auto text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
          {timeline.length} tool{timeline.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {timeline.map((tool: any, index: number) => {
          // Map ToolExecution status to ToolCallCard status
          const mappedStatus: ToolStatus =
            tool.status === "completed"
              ? "complete"
              : tool.status === "running"
                ? "running"
                : tool.status === "error"
                  ? "error"
                  : "pending";

          return (
            <ToolCallCard
              key={tool.id || index}
              tool={{
                id: tool.id,
                name: tool.name,
                status: mappedStatus,
                params: tool.params,
                result: tool.result,
                error: tool.error,
                duration: tool.duration,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
