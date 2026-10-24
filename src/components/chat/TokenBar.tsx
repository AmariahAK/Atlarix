import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCountTokens } from "@/hooks/useCountTokens";
import { labelForWorkMode } from "@/lib/work-mode";
import {
  MessageSquare,
  FileText,
  Search,
  Terminal,
  Sparkles,
  Bot,
  AlignLeft,
  Wrench,
  Braces,
} from "lucide-react";
import {
  chatInputValueAtom,
  lastAuxTokensByChatIdAtom,
  lastAuxBySourceByChatIdAtom,
  lastTurnCostUsdByChatIdAtom,
  sessionCostUsdByChatIdAtom,
  sessionTokensByChatIdAtom,
  liveTurnUsageByChatIdAtom,
  liveTurnToolBucketsByChatIdAtom,
  isStreamingForChatAtom,
} from "@/atoms/chatAtoms";
import { useAtom, useAtomValue } from "jotai";
import { useContextReport } from "@/hooks/useContextReport";
import { Scissors, Bot as BotIcon, DollarSign } from "lucide-react";
import { useChatModel } from "@/hooks/useChatModel";
import { TokenCircle } from "./TokenCircle";
import { useCompactionTokenVisuals } from "@/hooks/useCompactionTokenVisuals";
import { selectionUsesCompass } from "@/hooks/useCompassSendGate";
import { useCreditBalance } from "@/hooks/useCreditBalance";

interface TokenBarProps {
  chatId?: number;
}

/**
 * Internal context-section names are implementation detail. The footnote used to
 * print them raw — "activeSkill (truncated)" tells a user nothing they can act on.
 */
const SECTION_LABELS: Record<string, string> = {
  activeSkill: "Active skill",
  skillsIndex: "Skills index",
  workspaceCapabilities: "Workspace integrations",
  activePlan: "Session plan",
  projectMemory: "Project instructions",
  projectKnowledge: "Project memory",
  contextSummary: "Session summary",
  taskProgress: "Background results",
};

function sectionLabel(name: string): string {
  return SECTION_LABELS[name] ?? name;
}

export function TokenBar({ chatId }: TokenBarProps) {
  const [inputValue] = useAtom(chatInputValueAtom);
  // This chat's own model (15.11.1), not the app-wide pick.
  const chatModel = useChatModel(chatId).model;
  const { result, error } = useCountTokens(chatId ?? null, inputValue);
  const { pulse, flashSuccess } = useCompactionTokenVisuals(chatId ?? null);
  const creditBalance = useCreditBalance();
  // v10 context meter: what was assembled/trimmed at last dispatch + aux usage.
  const contextReport = useContextReport(chatId ?? null);
  const auxTokensByChat = useAtomValue(lastAuxTokensByChatIdAtom);
  const lastAuxTokens = chatId != null ? auxTokensByChat[chatId] : undefined;
  const auxBySourceByChat = useAtomValue(lastAuxBySourceByChatIdAtom);
  const lastAuxBySource =
    chatId != null ? auxBySourceByChat[chatId] : undefined;
  const turnCostByChat = useAtomValue(lastTurnCostUsdByChatIdAtom);
  const lastTurnCostUsd = chatId != null ? turnCostByChat[chatId] : undefined;
  // Fix 6: cumulative session spend/tokens (running total across all turns).
  const sessionCostByChat = useAtomValue(sessionCostUsdByChatIdAtom);
  const sessionCostUsd = chatId != null ? sessionCostByChat[chatId] : undefined;
  const sessionTokensByChat = useAtomValue(sessionTokensByChatIdAtom);
  const sessionTokens =
    chatId != null ? sessionTokensByChat[chatId] : undefined;

  // Live per-turn usage (Claude-Code-style): the provider's REAL context/output
  // tokens drive the headline, so the meter is live and provider-accurate (not
  // the Anthropic-tokenizer estimate). The atom is kept fresh by
  // useLiveTurnTokenUsage() mounted in the always-present composer — TokenBar
  // (a conditionally-mounted popover) only READS it, so the meter updates
  // whether or not this popover is open.
  const liveUsageByChat = useAtomValue(liveTurnUsageByChatIdAtom);
  const liveUsage = chatId != null ? liveUsageByChat[chatId] : undefined;
  // Per-tool attribution for the turn in flight (see the breakdown below).
  const liveBucketsByChat = useAtomValue(liveTurnToolBucketsByChatIdAtom);
  const liveBuckets = chatId != null ? liveBucketsByChat[chatId] : undefined;
  const isStreaming = useAtomValue(
    useMemo(() => isStreamingForChatAtom(chatId ?? -1), [chatId]),
  );

  // #3: notify when switching to a model whose context window is smaller than
  // the current usage. The dispatch already auto-compacts to fit; this is a
  // one-time transparency toast. Re-evaluated once the token count refetches
  // with the newly selected model's window.
  const modelKey = chatModel ? `${chatModel.provider}/${chatModel.name}` : "";
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
    conversationTokens,
    filesReadTokens,
    searchResultTokens,
    otherToolOutputTokens,
    systemPromptTokens,
    systemInstructionTokens,
    toolDescriptionTokens,
    toolSchemaTokens,
    workMode: meteredWorkMode,
    inputTokens,
    contextWindow,
    effectiveBudget,
    budgetSource,
    actualMaxTokens,
  } = result;

  // Skills, project instructions, memory index, plan, workspace capabilities —
  // everything ContextAssembler injects. Real post-dispatch numbers; before the
  // first dispatch there is no report and the row is genuinely 0.
  const contextSectionTokens = (contextReport?.sections ?? [])
    .filter((s) => s.included)
    .reduce((sum, s) => sum + s.tokens, 0);

  // Live attribution counts ONLY while a turn is in flight.
  //
  // Mid-turn the settled count-tokens numbers cannot see this turn's tool results
  // — they only land on the assistant row at finalize — so the meter adds main's
  // running attribution on top of the settled baseline. The moment the turn ends
  // that stops being true: `invalidateTokenCount()` refetches and the settled
  // numbers now include everything this turn read, while the live buckets still
  // hold the same turn's totals until the NEXT turn's rising edge clears them.
  // Adding both double-counted every file for the whole gap between turns —
  // 104,862 "Files read" against 46,725 of real context — and survived a revert,
  // because a revert only rewrites history (which settled re-reads) and never
  // touches this atom. Gating on `isStreaming` makes at-rest purely settled, so
  // the card is correct between turns and after a revert by construction.
  const live = isStreaming
    ? (liveBuckets ?? { filesRead: 0, searchResults: 0, otherToolOutput: 0 })
    : { filesRead: 0, searchResults: 0, otherToolOutput: 0 };
  const filesReadRow = filesReadTokens + live.filesRead;
  const searchResultRow = searchResultTokens + live.searchResults;
  const otherToolOutputRow = otherToolOutputTokens + live.otherToolOutput;

  // The breakdown's own total. It is the SUM OF THE ROWS by construction — the
  // card used to print the provider-reported figure here while the rows came
  // from the client estimate, so a user reading it saw seven numbers that did
  // not add up to the eighth (41,492 vs 48,107 in the wild). The provider's
  // number is a different measurement and gets its own labelled line below.
  const breakdownTotal =
    conversationTokens +
    filesReadRow +
    searchResultRow +
    otherToolOutputRow +
    contextSectionTokens +
    systemPromptTokens +
    inputTokens;

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

  // Provider truth, when the provider has actually told us something this
  // session. Drives the ring/headline; shown in the card only as its own line.
  const providerReportedTokens =
    liveUsage != null
      ? liveBaseline + liveUsage.output
      : actualMaxTokens != null
        ? actualMaxTokens
        : null;

  const budget =
    contextReport?.contextWindow ?? effectiveBudget ?? contextWindow;
  const percentUsed = Math.min((totalTokens / budget) * 100, 100);
  const usesCore = selectionUsesCompass(chatModel);
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
          {/* Auto-summarize is always on now, so there is no "you're on your
              own" branch left to warn about. */}
          {isCritical
            ? "Context nearly full — auto-summarize will run on next message"
            : "Approaching limit — session will auto-summarize when full"}
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
              {/*
                  THE RING AND A PERCENTAGE — NOT A RAW COUNT.

                  This used to lead with `{totalTokens} / {budgetLabel}`. Once the
                  meter started counting the tool surface honestly (it had been
                  omitting ~6,700 tokens), an untouched chat opened reading
                  "10,864 / 200K" — which reads as "you have already spent
                  something" before the user types a word. The number was right;
                  the impression was wrong.

                  A percentage says the same thing without the alarm: 5% is
                  legible, 10,864 is not. Every figure is still one hover away in
                  the card below, itemised into system / tool descriptions / tool
                  schemas / history / input — so this hides nothing, it stops
                  shouting. And the app's own arithmetic keeps the honest total,
                  because the budget enforcer and the compactor depend on it.
                */}
              <div className="flex flex-col min-w-0 leading-tight">
                <span className="text-muted-foreground tabular-nums truncate">
                  {Math.round(percentUsed)}% of {budgetLabel}
                  {budgetSource === "override" && (
                    <span className="text-muted-foreground/70 ml-0.5">
                      (capped)
                    </span>
                  )}
                </span>
                <span className="text-[10px] text-muted-foreground/80">
                  context
                  {coreCreditLabel ? (
                    <span className="ml-1.5 text-muted-foreground/70 tabular-nums">
                      · Core {coreCreditLabel}
                    </span>
                  ) : null}
                  {/* Fix 6: running session spend — actual provider burn,
                        which the occupancy meter above does NOT reflect. */}
                  {typeof sessionCostUsd === "number" && sessionCostUsd > 0 ? (
                    <span className="ml-1.5 text-emerald-500 tabular-nums">
                      · $
                      {sessionCostUsd < 0.01
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
              {/* Naming the mode matters now that the prefix is metered per
                    mode: Build binds every tool where Plan binds a subset, so
                    the same conversation prices differently and the reader
                    should not have to guess which mode produced the number. */}
              <div className="font-medium">
                Token usage
                <span className="font-normal text-muted-foreground">
                  {" · "}
                  {labelForWorkMode(meteredWorkMode)}
                </span>
              </div>
              <div className="grid grid-cols-[20px_1fr_auto] gap-x-2 items-center">
                <MessageSquare size={12} className="text-blue-500" />
                <span>Conversation</span>
                <span>{conversationTokens.toLocaleString()}</span>

                <FileText size={12} className="text-green-500" />
                <span>Files read</span>
                <span>{filesReadRow.toLocaleString()}</span>

                <Search size={12} className="text-orange-500" />
                <span>Search results</span>
                <span>{searchResultRow.toLocaleString()}</span>

                <Terminal size={12} className="text-sky-500" />
                <span>Other tool output</span>
                <span>{otherToolOutputRow.toLocaleString()}</span>

                <Sparkles size={12} className="text-fuchsia-500" />
                <span>Skills &amp; instructions</span>
                <span>{contextSectionTokens.toLocaleString()}</span>

                {/* The fixed prefix, split three ways. It used to be one
                      "System prompt" row carrying the instructions alone, which
                      hid ~10,000 tokens of tool descriptions and parameter
                      schemas that are billed on every turn. These three rows
                      PARTITION the prefix — they do not add to it — so the Total
                      below is unchanged in meaning. */}
                <Bot size={12} className="text-purple-500" />
                <span>System prompt</span>
                <span>{systemInstructionTokens.toLocaleString()}</span>

                <Wrench size={12} className="text-purple-400" />
                <span>Tool descriptions</span>
                <span>{toolDescriptionTokens.toLocaleString()}</span>

                <Braces size={12} className="text-purple-300" />
                <span>Tool schemas</span>
                <span>{toolSchemaTokens.toLocaleString()}</span>

                <AlignLeft size={12} className="text-yellow-500" />
                <span>Current input</span>
                <span>{inputTokens.toLocaleString()}</span>
              </div>
              <div className="pt-1 border-t border-border">
                <div className="flex justify-between font-medium">
                  <span>Total</span>
                  <span>{breakdownTotal.toLocaleString()}</span>
                </div>
                {/* The figure the RING is drawn from, stated once. The headline
                      shows a percentage now, so without this line the number
                      behind the ring would be visible nowhere — and it is not
                      always `breakdownTotal` above: `totalTokens` prefers the
                      provider's live report or the dispatched size when either
                      exists. Two honest measurements, both named. */}
                <div className="flex justify-between text-muted-foreground">
                  <span>Context used</span>
                  <span className="tabular-nums">
                    {totalTokens.toLocaleString()} / {budget.toLocaleString()}
                  </span>
                </div>
                {/* The provider counts with its own tokenizer and includes
                      cache/reasoning tokens the breakdown can't attribute, so it
                      rarely matches to the token. Showing it as its own line —
                      rather than as "Total" over rows that sum to something else
                      — is the difference between two honest measurements and one
                      card that contradicts itself. */}
                {providerReportedTokens != null &&
                providerReportedTokens !== breakdownTotal ? (
                  <div className="flex justify-between text-[10px] text-muted-foreground/80">
                    <span>Provider-reported</span>
                    <span>{providerReportedTokens.toLocaleString()}</span>
                  </div>
                ) : null}
              </div>
              {lastAuxTokens != null && lastAuxTokens > 0 ? (
                <div className="pt-1 border-t border-border">
                  <div className="grid grid-cols-[20px_1fr_auto] gap-x-2 items-center">
                    <BotIcon size={12} className="text-cyan-500" />
                    <span>Background work (last turn)</span>
                    <span>{lastAuxTokens.toLocaleString()}</span>
                  </div>
                  {/* Named per source: this line previously read "Sub-agents" while
                        also counting compaction, so app-initiated spend looked like
                        work the user had asked for. */}
                  {(lastAuxBySource ?? []).map(
                    ({ source, tokens, calls, estimatedTokens }) => (
                      <div
                        key={source}
                        className="grid grid-cols-[20px_1fr_auto] gap-x-2 items-center text-muted-foreground"
                      >
                        <span />
                        <span className="pl-1">
                          {source === "subagents"
                            ? `Sub-agents (${calls} call${calls === 1 ? "" : "s"})`
                            : source === "compaction"
                              ? "Context compaction"
                              : "Other"}
                        </span>
                        {/* A "~" whenever any of this figure was ESTIMATED rather than
                              reported by the provider. Some providers (free routes
                              especially) return no usage; those calls used to be dropped
                              from the total entirely, so the number was quietly too low.
                              They are counted now — but an estimate shown as measured
                              spend would be the worse bug of the two, so it is marked. */}
                        <span
                          title={
                            (estimatedTokens ?? 0) > 0
                              ? `${estimatedTokens.toLocaleString()} of these tokens are estimated — the provider reported no usage for at least one call`
                              : undefined
                          }
                        >
                          {(estimatedTokens ?? 0) > 0 ? "~" : ""}
                          {tokens.toLocaleString()}
                        </span>
                      </div>
                    ),
                  )}
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
                    <div
                      key={i}
                      className="text-[10px] text-muted-foreground break-words"
                    >
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
                    .map(
                      (s) =>
                        `${sectionLabel(s.name)}${s.truncated ? " (truncated)" : " (dropped)"}`,
                    )
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
