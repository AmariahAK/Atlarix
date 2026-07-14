import { useEffect, useMemo, useRef } from "react";
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
  liveTurnUsageByChatIdAtom,
  isStreamingForChatAtom,
} from "@/atoms/chatAtoms";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { IpcClient } from "@/ipc/ipc_client";
import { useContextReport } from "@/hooks/useContextReport";
import { Scissors, Bot as BotIcon, DollarSign } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { TokenCircle } from "./TokenCircle";
import { useCompactionTokenVisuals } from "@/hooks/useCompactionTokenVisuals";
import { selectionUsesCompass } from "@/hooks/useCompassSendGate";
import { useCreditBalance } from "@/hooks/useCreditBalance";

interface TokenBarProps {
  chatId?: number;
}

export function TokenBar({ chatId }: TokenBarProps) {
  const [inputValue] = useAtom(chatInputValueAtom);
  const { settings } = useSettings();
  const { result, error } = useCountTokens(chatId ?? null, inputValue);
  const { pulse, flashSuccess } = useCompactionTokenVisuals(chatId ?? null);
  const creditBalance = useCreditBalance();
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

  // Live per-turn usage (Claude-Code-style): the provider's REAL context/output
  // tokens streamed during a turn drive the headline, so the meter is live and
  // provider-accurate (not the Anthropic-tokenizer estimate). Held at rest as
  // the authoritative last-known occupancy until the next turn starts.
  const setLiveUsage = useSetAtom(liveTurnUsageByChatIdAtom);
  const liveUsageByChat = useAtomValue(liveTurnUsageByChatIdAtom);
  const liveUsage = chatId != null ? liveUsageByChat[chatId] : undefined;
  const isStreaming = useAtomValue(
    useMemo(() => isStreamingForChatAtom(chatId ?? -1), [chatId]),
  );
  useEffect(() => {
    const unsub = IpcClient.getInstance().onTokenUsage((p) => {
      if (chatId == null || p.chatId !== chatId) return;
      setLiveUsage((prev) => {
        const cur = prev[chatId];
        // Real provider usage (inputTokens set) is authoritative — overwrite.
        if (p.inputTokens != null) {
          return { ...prev, [chatId]: { input: p.inputTokens, output: p.outputTokens } };
        }
        // Throttled stream estimate — only applies before the first real step
        // this turn (input still null); once real data arrives we ignore it to
        // avoid per-step jitter. Output only grows.
        if (cur?.input != null) return prev;
        return {
          ...prev,
          [chatId]: { input: null, output: Math.max(cur?.output ?? 0, p.outputTokens) },
        };
      });
    });
    return unsub;
  }, [chatId, setLiveUsage]);
  // New stream → clear stale live usage so it ticks fresh (kept at rest otherwise).
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (isStreaming && !prevStreamingRef.current && chatId != null) {
      setLiveUsage((prev) => {
        if (!prev[chatId]) return prev;
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming, chatId, setLiveUsage]);

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
    actualMaxTokens,
  } = result;

  // Headline = the MODEL-FACING context. After a dispatch the backend reports
  // the actual dispatched size (post compaction/slice); show that + the current
  // input preview so the meter reflects what the model holds and DROPS after a
  // summarize, instead of the full untrimmed conversation estimate. Falls back
  // to the estimate before the first dispatch.
  const dispatchedTokens = contextReport?.dispatchedTokens;
  // Prefer live provider usage when present: real context (input) + output. The
  // input baseline falls back to the dispatch estimate before the provider's
  // first usage report. At rest (not streaming) add the composer draft so the
  // meter previews what the NEXT send will occupy.
  const liveBaseline =
    liveUsage?.input ??
    dispatchedTokens ??
    Math.max(estimatedTotalTokens - inputTokens, 0);
  const composerDraftTokens = isStreaming ? 0 : inputTokens;
  const totalTokens =
    liveUsage != null
      ? liveBaseline + liveUsage.output + composerDraftTokens
      : // Reloaded session (no live emit yet): the provider's real last-turn
        // total is more accurate than the client-side estimate.
        actualMaxTokens != null && !isStreaming
        ? actualMaxTokens + inputTokens
        : dispatchedTokens != null
          ? dispatchedTokens + inputTokens
          : estimatedTotalTokens;

  const budget = contextReport?.contextWindow ?? effectiveBudget ?? contextWindow;
  const percentUsed = Math.min((totalTokens / budget) * 100, 100);
  const usesCore = selectionUsesCompass(settings?.selectedModel);
  const coreCreditLabel =
    usesCore && !creditBalance.loading && creditBalance.balanceCents != null
      ? `$${(creditBalance.balanceCents / 100).toFixed(2)}`
      : null;

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
                    {coreCreditLabel ? (
                      <span className="ml-1.5 text-muted-foreground/70 tabular-nums">
                        · Core {coreCreditLabel}
                      </span>
                    ) : null}
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
      {error && (
        <div className="text-red-500 text-xs mt-1">Failed to count tokens</div>
      )}
    </div>
  );
}
