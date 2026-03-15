import { useState } from "react";
import { ContextFilesPicker } from "./ContextFilesPicker";
import { ModelPickerSheetContent } from "./ModelPickerSheetContent";
import { ChatConfigDropdown } from "./ChatConfigDropdown";
import { ChatIntentSelector } from "./ChatIntentSelector";
import { McpToolsPickerContent } from "@/components/McpToolsPicker";
import { AutoConfigContent } from "@/components/AutoConfigContent";
import { useSettings } from "@/hooks/useSettings";
import { useCountTokens } from "@/hooks/useCountTokens";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useAtomValue } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { rightPanelVisibleAtom } from "@/atoms/sourceAtoms";
import { NoWorkspaceBanner } from "./chat/NoWorkspaceBanner";
import { CompactModelSearch } from "./CompactModelSearch";

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function ChatInputControls({
  showContextFilesPicker = false,
  chatId,
}: {
  showContextFilesPicker?: boolean;
  chatId?: number;
}) {
  const appId = useAtomValue(selectedAppIdAtom);
  const rightPanelVisible = useAtomValue(rightPanelVisibleAtom);
  const { settings } = useSettings();
  const [configSubView, setConfigSubView] = useState<
    "model" | "mcp" | "auto" | null
  >(null);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const { result: tokenResult } = useCountTokens(chatId ?? null, "");

  const agentMode = settings?.agentMode ?? "guided";
  const intentMode = settings?.intentMode ?? (settings?.selectedChatMode === "agent" ? "build" : settings?.selectedChatMode) ?? "build";
  const effectiveMode =
    settings?.selectedChatMode === "agent"
      ? "build"
      : settings?.selectedChatMode ?? "build";

  let contextLine =
    !appId
      ? `${effectiveMode === "ask" ? "Ask" : "Build"} · No workspace`
      : intentMode === "auto"
        ? `Auto · ${effectiveMode === "ask" ? "Ask" : "Build"} · ${agentMode === "direct" ? "Direct" : agentMode === "guided" ? "Guided" : "Autonomous"}`
        : `${effectiveMode === "ask" ? "Ask" : "Build"} · ${agentMode === "direct" ? "Direct" : agentMode === "guided" ? "Guided" : "Autonomous"}`;

  let tokenWarning: string | null = null;
  const usedTokens = tokenResult?.estimatedTotalTokens ?? 0;
  const budgetTokens = tokenResult?.effectiveBudget ?? tokenResult?.contextWindow ?? 0;
  const contextPercent = budgetTokens > 0 ? Math.min(100, (usedTokens / budgetTokens) * 100) : 0;

  if (agentMode === "autonomous" && chatId && tokenResult) {
    contextLine += ` · ${formatTokens(usedTokens)}/${formatTokens(budgetTokens)} tokens`;
    if (budgetTokens > 0) {
      if (contextPercent >= 100) tokenWarning = "Token limit reached";
      else if (contextPercent >= 80) tokenWarning = "Approaching token limit";
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {!appId && <NoWorkspaceBanner className="mb-1" />}

      {/* Compact context line + non-clickable context usage bar */}
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-0.5 text-xs text-muted-foreground"
        data-testid="active-context-bar"
      >
        <span>{contextLine}</span>
        {tokenWarning && (
          <span className="text-amber-600 dark:text-amber-400" title={tokenWarning}>
            ({tokenWarning})
          </span>
        )}
        {chatId != null && budgetTokens > 0 && (
          <div
            className="flex items-center gap-1.5 min-w-0 flex-1 max-w-[120px]"
            title={`Context: ${formatTokens(usedTokens)} / ${formatTokens(budgetTokens)} tokens (${contextPercent.toFixed(0)}%)`}
          >
            <div className="h-1.5 flex-1 min-w-[40px] rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary/70 transition-[width] duration-300"
                style={{ width: `${contextPercent}%` }}
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        {rightPanelVisible && (
          <CompactModelSearch className="shrink-0" />
        )}
        <Popover
          open={configSubView !== null}
          onOpenChange={(open) => !open && setConfigSubView(null)}
        >
          <PopoverAnchor asChild>
            <span className="inline-flex">
              <ChatConfigDropdown
                onOpenModelPicker={
                  rightPanelVisible
                    ? undefined
                    : () => {
                        setConfigSubView(null);
                        setModelSheetOpen(true);
                      }
                }
                onOpenMcpTools={() => setConfigSubView("mcp")}
                onOpenAutoConfig={() => setConfigSubView("auto")}
              />
            </span>
          </PopoverAnchor>
          <PopoverContent align="start" className="w-auto max-w-[90vw] p-0">
            {configSubView === "mcp" && <McpToolsPickerContent appId={appId} />}
            {configSubView === "auto" && <AutoConfigContent />}
          </PopoverContent>
        </Popover>

        {!rightPanelVisible && (
        <Sheet open={modelSheetOpen} onOpenChange={setModelSheetOpen}>
          <SheetContent
            side="right"
            className="sm:max-w-md overflow-y-auto"
          >
            <SheetHeader>
              <SheetTitle>Change model</SheetTitle>
            </SheetHeader>
            <ModelPickerSheetContent onClose={() => setModelSheetOpen(false)} />
          </SheetContent>
        </Sheet>
        )}

        <ChatIntentSelector />

        {showContextFilesPicker && (
          <>
            <div className="w-1" />
            <ContextFilesPicker />
          </>
        )}
      </div>
    </div>
  );
}
