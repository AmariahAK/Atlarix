/**
 * WorkspacePanelBar - Quick access to Diagram | Preview | Code
 * Shows when workspace is selected, above the main content.
 * Lets users view diagram/preview/code without sending first prompt.
 */

import { useAtomValue, useSetAtom } from "jotai";
import {
  rightPanelVisibleAtom,
  previewTabAtom,
  pinnedPanelAtom,
  devServerUrlAtom,
} from "@/atoms/sourceAtoms";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { Workflow, Eye, Code2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";

type QuickTab = "diagram" | "preview" | "code";

export function WorkspacePanelBar() {
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const setRightPanelVisible = useSetAtom(rightPanelVisibleAtom);
  const setPreviewTab = useSetAtom(previewTabAtom);
  const setPinnedPanel = useSetAtom(pinnedPanelAtom);
  const devServerUrl = useAtomValue(devServerUrlAtom);

  if (!selectedAppId) return null;

  // Always use toolbar right panel (code-preview) so user sees all 7 tabs; just switch active tab
  const handleQuickTab = (tab: QuickTab) => {
    setPinnedPanel("code-preview");
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
                onClick={() => handleQuickTab("diagram")}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors text-muted-foreground hover:text-foreground"
              >
                <Workflow className="h-3.5 w-3.5" />
                Diagram
              </button>
            </TooltipTrigger>
            <TooltipContent>View project architecture diagram</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => handleQuickTab("preview")}
                disabled={!hasPreview}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors",
                  hasPreview ? "text-muted-foreground hover:text-foreground" : "text-muted-foreground/50 cursor-not-allowed"
                )}
              >
                <Eye className="h-3.5 w-3.5" />
                Preview
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {hasPreview ? "Live app preview" : "Start dev server to see preview"}
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
