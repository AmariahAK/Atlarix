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
import { TokenCircle } from "./TokenCircle";
import { useCompactionTokenVisuals } from "@/hooks/useCompactionTokenVisuals";
import { selectionUsesCompass } from "@/hooks/useCompassSendGate";
import { useCompassUsage } from "@/hooks/useCompassUsage";
import { CompassUsageStrip } from "./CompassUsageStrip";
import { formatCompassSubscriptionTier } from "@/shared/compass_product_copy";

interface TokenBarProps {
  chatId?: number;
  /**
   * When true and Compass monthly quota is loaded, show the monthly strip here.
   * Default false — monthly quota is shown once in ChatPanel (or home composer footer).
   */
  includeCompassMonthlyStrip?: boolean;
}

export function TokenBar({
  chatId,
  includeCompassMonthlyStrip = false,
}: TokenBarProps) {
  const [inputValue] = useAtom(chatInputValueAtom);
  const { settings } = useSettings();
  const { result, error } = useCountTokens(chatId ?? null, inputValue);
  const { pulse, flashSuccess } = useCompactionTokenVisuals(chatId ?? null);
  const compassUsage = useCompassUsage();

  if (chatId == null || !result) {
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
  const usesCompass = selectionUsesCompass(settings?.selectedModel);
  const compassQuotaReady =
    usesCompass &&
    !compassUsage.loading &&
    compassUsage.percentRemaining != null &&
    compassUsage.monthlyLimit != null;

  const isCritical = percentUsed >= 90;
  const showWarningBanner = percentUsed >= 80;

  const budgetLabel =
    budget >= 1_000_000
      ? `${(budget / 1_000_000).toFixed(1)}M`
      : `${(budget / 1000).toFixed(0)}K`;

  return (
    <div className="px-4 pb-2 text-xs" data-testid="token-bar">
      {showWarningBanner && (
        <div
          className={`mb-1.5 px-2 py-1 rounded text-xs ${
            isCritical
              ? "bg-red-500/15 text-red-600 dark:text-red-400"
              : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
          }`}
        >
          {isCritical
            ? settings?.enableContextAutoSummarize !== false
              ? "Context nearly full — auto-summarize will run on next message"
              : "Token limit nearly reached — consider starting a new chat"
            : settings?.enableContextAutoSummarize !== false
              ? "Approaching limit — session will auto-summarize when full"
              : "Approaching token limit"}
        </div>
      )}
      {compassQuotaReady && includeCompassMonthlyStrip ? (
        <CompassUsageStrip
          subscriptionTierLabel={
            compassUsage.tier
              ? formatCompassSubscriptionTier(compassUsage.tier)
              : "—"
          }
          tokensUsedThisMonth={compassUsage.tokensUsedThisMonth}
          monthlyLimit={compassUsage.monthlyLimit}
          percentRemaining={compassUsage.percentRemaining}
          loading={false}
        />
      ) : (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2 w-full min-w-0">
                <TokenCircle
                  used={totalTokens}
                  total={budget}
                  size={24}
                  pulse={pulse}
                  flashSuccess={flashSuccess}
                />
                <div className="flex flex-col min-w-0 leading-tight">
                  <span className="text-muted-foreground tabular-nums truncate">
                    {totalTokens.toLocaleString()} / {budgetLabel}
                    {budgetSource === "override" && (
                      <span className="text-muted-foreground/70 ml-0.5">(capped)</span>
                    )}
                  </span>
                  <span className="text-[10px] text-muted-foreground/80">
                    {Math.round(percentUsed)}% context
                  </span>
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="w-64 p-2">
              <div className="space-y-1">
                <div className="font-medium">Token usage</div>
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
      )}
      {error && (
        <div className="text-red-500 text-xs mt-1">Failed to count tokens</div>
      )}
    </div>
  );
}
