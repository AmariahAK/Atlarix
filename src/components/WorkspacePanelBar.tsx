/**
 * WorkspacePanelBar - Quick access to Preview | Code | Activity
 * Shows when workspace is selected, above the main content.
 */

import { useAtomValue, useSetAtom } from "jotai";
import {
  rightPanelVisibleAtom,
  rightPanelSuppressAutoOpenAtom,
  previewTabAtom,
  pinnedPanelAtom,
  devServerUrlAtom,
} from "@/atoms/sourceAtoms";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { useSelectedDevServer } from "@/hooks/useDevServer";
import { Eye, Code2, ListTree } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";

type QuickTab = "activity" | "preview" | "code";

export function WorkspacePanelBar() {
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const setSuppressRightAutoOpen = useSetAtom(rightPanelSuppressAutoOpenAtom);
  const setPreviewTab = useSetAtom(previewTabAtom);
  const setPinnedPanel = useSetAtom(pinnedPanelAtom);
  const devServerUrl = useAtomValue(devServerUrlAtom);
  const { start: startDevServer, isFrontend } = useSelectedDevServer();

  if (!selectedAppId) return null;

  // Always use toolbar right panel (code-preview) so user sees all 7 tabs; just switch active tab
  const handleQuickTab = async (tab: QuickTab) => {
    if (tab === "preview" && !devServerUrl && isFrontend) {
      await startDevServer();
    }
    setPinnedPanel("code-preview");
    setSuppressRightAutoOpen(false);
    setRightPanelVisible(true);
    setPreviewTab(tab);
  };

  const hasPreview = !!devServerUrl;

  return (
    <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30">
      <div className="flex items-center gap-1">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => handleQuickTab("activity")}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors text-muted-foreground hover:text-foreground"
              >
                <ListTree className="h-3.5 w-3.5" />
                Activity
              </button>
            </TooltipTrigger>
            <TooltipContent>Tool and session activity</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => void handleQuickTab("preview")}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors",
                  hasPreview || isFrontend
                    ? "text-muted-foreground hover:text-foreground"
                    : "text-muted-foreground/50 cursor-not-allowed",
                )}
              >
                <Eye className="h-3.5 w-3.5" />
                Preview
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {hasPreview
                ? "Live app preview"
                : isFrontend
                  ? "Start dev server for preview"
                  : "Preview unavailable for this workspace"}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => handleQuickTab("code")}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors",
                  "text-muted-foreground hover:text-foreground"
                )}
              >
                <Code2 className="h-3.5 w-3.5" />
                Code
              </button>
            </TooltipTrigger>
            <TooltipContent>View and edit code files</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {/* Right panel toggle is only shown on chat page (ChatHeader / PersistentChatContainer), not here */}
    </div>
  );
}
