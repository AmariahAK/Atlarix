import { useState } from "react";
import { ContextFilesPicker } from "./ContextFilesPicker";
import { ModelPicker } from "./ModelPicker";
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
import { NoWorkspaceBanner } from "./chat/NoWorkspaceBanner";

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
  if (agentMode === "autonomous" && chatId && tokenResult) {
    const used = tokenResult.estimatedTotalTokens;
    const budget = tokenResult.effectiveBudget ?? tokenResult.contextWindow ?? 0;
    contextLine += ` · ${formatTokens(used)}/${formatTokens(budget)} tokens`;
    if (budget > 0) {
      const pct = (used / budget) * 100;
      if (pct >= 100) tokenWarning = "Token limit reached";
      else if (pct >= 80) tokenWarning = "Approaching token limit";
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {!appId && <NoWorkspaceBanner className="mb-1" />}

      {/* Compact context line */}
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
      </div>

      <div className="flex items-center gap-2">
        <Popover
          open={configSubView !== null}
          onOpenChange={(open) => !open && setConfigSubView(null)}
        >
          <PopoverAnchor asChild>
            <span className="inline-flex">
              <ChatConfigDropdown
                onOpenModelPicker={() => {
                  setConfigSubView(null);
                  setModelSheetOpen(true);
                }}
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

        <Sheet open={modelSheetOpen} onOpenChange={setModelSheetOpen}>
          <SheetContent
            side="right"
            className="sm:max-w-md overflow-y-auto"
          >
            <SheetHeader>
              <SheetTitle>Change model</SheetTitle>
            </SheetHeader>
            <ModelPicker />
          </SheetContent>
        </Sheet>

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
