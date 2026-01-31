import React from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCountTokens } from "@/hooks/useCountTokens";
import {
  MessageSquare,
  Code,
  Bot,
  AlignLeft,
  ExternalLink,
} from "lucide-react";
import { chatInputValueAtom } from "@/atoms/chatAtoms";
import { useAtom } from "jotai";
import { useSettings } from "@/hooks/useSettings";
import { IpcClient } from "@/ipc/ipc_client";

interface TokenBarProps {
  chatId?: number;
}

export function TokenBar({ chatId }: TokenBarProps) {
  const [inputValue] = useAtom(chatInputValueAtom);
  const { settings } = useSettings();
  const { result, error } = useCountTokens(chatId ?? null, inputValue);

  if (!chatId || !result) {
    return null;
  }

  const {
    estimatedTotalTokens: totalTokens,
    messageHistoryTokens,
    codebaseTokens,
    mentionedAppsTokens,
    systemPromptTokens,
    inputTokens,
    contextWindow,
    effectiveBudget,
    budgetSource,
  } = result;

  const budget = effectiveBudget ?? contextWindow;
  const percentUsed = Math.min((totalTokens / budget) * 100, 100);

  // Warning levels for display
  const isWarning = percentUsed >= 70;
  const isCritical = percentUsed >= 90;
  const showWarningText = percentUsed >= 80;

  // Calculate widths for each token type
  const messageHistoryPercent = (messageHistoryTokens / budget) * 100;
  const codebasePercent = (codebaseTokens / budget) * 100;
  const mentionedAppsPercent = (mentionedAppsTokens / budget) * 100;
  const systemPromptPercent = (systemPromptTokens / budget) * 100;
  const inputPercent = (inputTokens / budget) * 100;

  return (
    <div className="px-4 pb-2 text-xs" data-testid="token-bar">
      {showWarningText && (
        <div
          className={`mb-1.5 px-2 py-1 rounded text-xs ${
            isCritical
              ? "bg-red-500/15 text-red-600 dark:text-red-400"
              : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
          }`}
        >
          {isCritical
            ? "Token limit nearly reached — consider starting a new chat"
            : "Approaching token limit"}
        </div>
      )}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="w-full">
              <div className="flex justify-between mb-1 text-xs text-muted-foreground">
                <span>Tokens: {totalTokens.toLocaleString()}</span>
                <span>
                  {Math.round(percentUsed)}% of{" "}
                  {(budget / 1000).toFixed(0)}K
                  {budgetSource === "override" && (
                    <span className="text-muted-foreground/70 ml-0.5">
                      (capped)
                    </span>
                  )}
                </span>
              </div>
              <div
                className={`w-full h-1.5 rounded-full overflow-hidden flex ${
                  isCritical
                    ? "bg-red-500/20 ring-1 ring-red-500/40"
                    : isWarning
                      ? "bg-amber-500/20 ring-1 ring-amber-500/40"
                      : "bg-muted"
                }`}
              >
                {/* Message history tokens */}
                <div
                  className="h-full bg-blue-400"
                  style={{ width: `${messageHistoryPercent}%` }}
                />
                {/* Codebase tokens */}
                <div
                  className="h-full bg-green-400"
                  style={{ width: `${codebasePercent}%` }}
                />
                {/* Mentioned apps tokens */}
                <div
                  className="h-full bg-orange-400"
                  style={{ width: `${mentionedAppsPercent}%` }}
                />
                {/* System prompt tokens */}
                <div
                  className="h-full bg-purple-400"
                  style={{ width: `${systemPromptPercent}%` }}
                />
                {/* Input tokens */}
                <div
                  className="h-full bg-yellow-400"
                  style={{ width: `${inputPercent}%` }}
                />
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="w-64 p-2">
            <div className="space-y-1">
              <div className="font-medium">Token Usage Breakdown</div>
              <div className="grid grid-cols-[20px_1fr_auto] gap-x-2 items-center">
                <MessageSquare size={12} className="text-blue-500" />
                <span>Message History</span>
                <span>{messageHistoryTokens.toLocaleString()}</span>

                <Code size={12} className="text-green-500" />
                <span>Codebase</span>
                <span>{codebaseTokens.toLocaleString()}</span>

                <ExternalLink size={12} className="text-orange-500" />
                <span>Mentioned Apps</span>
                <span>{mentionedAppsTokens.toLocaleString()}</span>

                <Bot size={12} className="text-purple-500" />
                <span>System Prompt</span>
                <span>{systemPromptTokens.toLocaleString()}</span>

                <AlignLeft size={12} className="text-yellow-500" />
                <span>Current Input</span>
                <span>{inputTokens.toLocaleString()}</span>
              </div>
              <div className="pt-1 border-t border-border">
                <div className="flex justify-between font-medium">
                  <span>Total</span>
                  <span>{totalTokens.toLocaleString()}</span>
                </div>
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {error && (
        <div className="text-red-500 text-xs mt-1">Failed to count tokens</div>
      )}
      {(!settings?.enableProSmartFilesContextMode ||
        !settings?.enableAtlarixPro) && (
          <div className="text-xs text-center text-muted-foreground mt-2">
            Optimize your tokens with{" "}
            <a
              onClick={() => {
                if (settings?.enableAtlarixPro) {
                  IpcClient.getInstance().openExternalUrl(
                    "https://www.atlarix.dev/docs/guides/ai-models/pro-modes#smart-context",
                  );
                } else {
                  import("@/hooks/useUpgrade").then(({ triggerUpgrade }) => {
                    triggerUpgrade();
                  });
                }
              }}
              className="text-blue-500 dark:text-blue-400 cursor-pointer hover:underline"
            >
              Atlarix Pro's Smart Context
            </a>
          </div>
        )}
    </div>
  );
}
