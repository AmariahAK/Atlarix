import { useEffect, useRef } from "react";
import { toast } from "sonner";
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
import {
  chatInputValueAtom,
  lastAuxTokensByChatIdAtom,
  lastTurnCostUsdByChatIdAtom,
  sessionCostUsdByChatIdAtom,
  sessionTokensByChatIdAtom,
} from "@/atoms/chatAtoms";
import { useAtom, useAtomValue } from "jotai";
import { useContextReport } from "@/hooks/useContextReport";
import { Scissors, Bot as BotIcon, DollarSign } from "lucide-react";
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
  // v10 context meter: what was assembled/trimmed at last dispatch + aux usage.
  const contextReport = useContextReport(chatId ?? null);
  const auxTokensByChat = useAtomValue(lastAuxTokensByChatIdAtom);
  const lastAuxTokens = chatId != null ? auxTokensByChat[chatId] : undefined;
  const turnCostByChat = useAtomValue(lastTurnCostUsdByChatIdAtom);
  const lastTurnCostUsd = chatId != null ? turnCostByChat[chatId] : undefined;
  // Fix 6: cumulative session spend/tokens (running total across all turns).
  const sessionCostByChat = useAtomValue(sessionCostUsdByChatIdAtom);
  const sessionCostUsd = chatId != null ? sessionCostByChat[chatId] : undefined;
  const sessionTokensByChat = useAtomValue(sessionTokensByChatIdAtom);
  const sessionTokens = chatId != null ? sessionTokensByChat[chatId] : undefined;

  // #3: notify when switching to a model whose context window is smaller than
  // the current usage. The dispatch already auto-compacts to fit; this is a
  // one-time transparency toast. Re-evaluated once the token count refetches
  // with the newly selected model's window.
  const modelKey = settings?.selectedModel
    ? `${settings.selectedModel.provider}/${settings.selectedModel.name}`
    : "";
  const prevModelKeyRef = useRef(modelKey);
  const awaitingSwitchRef = useRef(false);
  useEffect(() => {
    if (modelKey && modelKey !== prevModelKeyRef.current) {
      prevModelKeyRef.current = modelKey;
      awaitingSwitchRef.current = true;
    }
  }, [modelKey]);
  useEffect(() => {
    if (!awaitingSwitchRef.current || !result) return;
    awaitingSwitchRef.current = false;
    const window = result.contextWindow;
    if (window && result.estimatedTotalTokens > window) {
      const w =
        window >= 1_000_000
          ? `${(window / 1_000_000).toFixed(1)}M`
          : `${Math.round(window / 1000)}K`;
      toast.message(
        `Switched to a ${w}-context model. Older context will be compacted to fit.`,
        { duration: 6000 },
      );
    }
  }, [result]);

  if (chatId == null || !result) {
    return null;
  }

  const {
    estimatedTotalTokens,
    messageHistoryTokens,
    codebaseTokens,
    mentionedAppsTokens,
    systemPromptTokens,
    inputTokens,
    contextWindow,
    effectiveBudget,
    budgetSource,
  } = result;

  // Headline = the MODEL-FACING context. After a dispatch the backend reports
  // the actual dispatched size (post compaction/slice); show that + the current
  // input preview so the meter reflects what the model holds and DROPS after a
  // summarize, instead of the full untrimmed conversation estimate. Falls back
  // to the estimate before the first dispatch.
  const dispatchedTokens = contextReport?.dispatchedTokens;
  const totalTokens =
    dispatchedTokens != null
      ? dispatchedTokens + inputTokens
      : estimatedTotalTokens;

  const budget = contextReport?.contextWindow ?? effectiveBudget ?? contextWindow;
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
                    {/* Fix 6: running session spend — actual provider burn,
                        which the occupancy meter above does NOT reflect. */}
                    {typeof sessionCostUsd === "number" && sessionCostUsd > 0 ? (
                      <span className="ml-1.5 text-emerald-500 tabular-nums">
                        · ${sessionCostUsd < 0.01
                          ? sessionCostUsd.toFixed(4)
                          : sessionCostUsd.toFixed(2)}{" "}
                        session
                      </span>
                    ) : typeof sessionTokens === "number" && sessionTokens > 0 ? (
                      <span className="ml-1.5 text-muted-foreground/70 tabular-nums">
                        · {sessionTokens.toLocaleString()} tok session
                      </span>
                    ) : null}
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
                  <span>Mentioned files</span>
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
                {lastAuxTokens != null && lastAuxTokens > 0 ? (
                  <div className="pt-1 border-t border-border grid grid-cols-[20px_1fr_auto] gap-x-2 items-center">
                    <BotIcon size={12} className="text-cyan-500" />
                    <span>Sub-agents (last turn)</span>
                    <span>{lastAuxTokens.toLocaleString()}</span>
                  </div>
                ) : null}
                {lastTurnCostUsd != null && lastTurnCostUsd > 0 ? (
                  <div className="pt-1 border-t border-border grid grid-cols-[20px_1fr_auto] gap-x-2 items-center">
                    <DollarSign size={12} className="text-emerald-500" />
                    <span>Est. cost (last turn)</span>
                    <span>
                      {lastTurnCostUsd < 0.01
                        ? `<$0.01`
                        : `$${lastTurnCostUsd.toFixed(2)}`}
                    </span>
                  </div>
                ) : null}
                {contextReport && contextReport.trimReport.length > 0 ? (
                  <div className="pt-1 border-t border-border space-y-0.5">
                    <div className="flex items-center gap-1 font-medium">
                      <Scissors size={12} className="text-muted-foreground" />
                      <span>Pruned at last dispatch</span>
                    </div>
                    {contextReport.trimReport.slice(0, 4).map((line, i) => (
                      <div key={i} className="text-[10px] text-muted-foreground break-words">
                        {line}
                      </div>
                    ))}
                    {contextReport.trimReport.length > 4 ? (
                      <div className="text-[10px] text-muted-foreground/70">
                        +{contextReport.trimReport.length - 4} more
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {contextReport &&
                contextReport.sections.some((s) => !s.included || s.truncated) ? (
                  <div className="text-[10px] text-muted-foreground/80">
                    {contextReport.sections
                      .filter((s) => !s.included || s.truncated)
                      .map((s) => `${s.name}${s.truncated ? " (truncated)" : " (dropped)"}`)
                      .join(", ")}
                  </div>
                ) : null}
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
