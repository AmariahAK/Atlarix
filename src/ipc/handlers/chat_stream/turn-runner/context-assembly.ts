/**
 * runContextAssembly — the per-turn context compaction/assembly phase, extracted
 * verbatim from runStream's assembly IIFE. Runs the 55%/75%/90% fill gates
 * (with runCompressAndRebuild nested inside, exactly as before) and emits the
 * live context-report. Threaded return-style: takes the current assembly working
 * set as `state`, mutates its own locals, and RETURNS the final set (+ the
 * proactive-reminder string) for the caller to write back — no shared-mutable
 * reassignment across the boundary.
 *
 * (Satellite: never imports the parent handler.)
 */

import log from "electron-log";
import type { IpcMainInvokeEvent } from "electron";
import type { ModelMessage } from "ai";
import type { ChatContextReport, ChatStreamParams } from "@/ipc/ipc_types";
import type { UserSettings, LargeLanguageModel } from "@/lib/schemas";
import type { ContextSection } from "@/lib/context/ContextAssembler";
import { getEffectiveModelForOptions } from "@/ipc/utils/get_model_client";
import { safeSend } from "@/ipc/utils/safe_sender";

import { estimateTokens } from "@/ipc/utils/token_utils";
import {
  buildPromptBundle,
  type PromptBundle,
  type PromptBundleDeps,
} from "@/ipc/handlers/chat_stream/turn-runner/prompt-bundle";
import { ContextBudgetTracker } from "@/lib/context/context-budget-tracker";
import { emitCompactionActivity } from "@/ipc/handlers/chat_stream/compaction-activity";
import {
  enforceContextBudget,
  estimateDispatchTokens,
} from "@/lib/routing/tier_context_budget";

const logger = log.scope("chat_stream_handlers");

/** The assembly working set: passed in, mutated internally, returned. */
export interface ContextAssemblyState {
  systemPrompt: string;
  // `any[]` mirrors runStream: updatedChat is `any`, so messageHistory /
  // limitedMessageHistory are untyped there — and enforceContextBudget's
  // BudgetHistoryMessage (role: string, content?: string) flows through here.
  limitedMessageHistory: any[];
  contextAssemblerBlob: string;
  codebasePrefix: readonly ModelMessage[];
  otherCodebasePrefix: readonly ModelMessage[];
  dispatchEstimate: number;
  budgetTracker: ContextBudgetTracker;
  workingSections: ContextSection[];
  promptBundle: PromptBundle;
  contextSections: ContextSection[];
}

export interface ContextAssemblyDeps {
  settings: UserSettings;
  effectiveModel: LargeLanguageModel;
  userPrompt: string;
  req: ChatStreamParams;
  updatedChat: any;
  event: IpcMainInvokeEvent;
  modelContextResolved: { tierLimit: number };
  promptBundleDeps: PromptBundleDeps;
  contextWindowTokens: number;
  /** Window minus the reply reserve — what a request may actually occupy. */
  usableTokens: number;
  /**
   * Bound tool descriptions + parameter schemas for this turn, measured ONCE by
   * the caller (`chat_stream_handlers`) via `measureToolSurface`.
   *
   * Passed in rather than derived here on purpose: this file has
   * `effectiveModel` and `req` but not `effectiveWorkMode`, so deriving it
   * would mean a second resolution of the work mode — and two places answering
   * that question is precisely how the context meter came to price a prompt
   * shape no dispatch had ever sent.
   */
  toolSurfaceTokens: number;
}

export async function runContextAssembly(
  state: ContextAssemblyState,
  deps: ContextAssemblyDeps,
): Promise<
  ContextAssemblyState & { proactiveContextReminderForStream: string | undefined }
> {
  const {
    settings,
    effectiveModel,
    userPrompt,
    req,
    updatedChat,
    event,
    modelContextResolved,
    promptBundleDeps,
    toolSurfaceTokens,
    contextWindowTokens,
    usableTokens,
  } = deps;
  let {
    systemPrompt,
    limitedMessageHistory,
    contextAssemblerBlob,
    codebasePrefix,
    otherCodebasePrefix,
    dispatchEstimate,
    budgetTracker,
    workingSections,
    promptBundle,
    contextSections,
  } = state;
  let proactiveContextReminderForStream: string | undefined;
            // Two kinds now, once each per dispatch: the model-facing fill
            // REMINDER, and the one COMPACT decision. It used to carry a
            // `gate: 55 | 75 | 90` and three "have I logged this yet" flags,
            // because there were two compaction gates to distinguish. There is one.
            const loggedOnce = { reminder: false, compact: false };
            const logCompactionLine = (est: number, kind: "reminder" | "compact") => {
              if (loggedOnce[kind]) return;
              loggedOnce[kind] = true;
              const pct = (est / contextWindowTokens) * 100;
              logger.info(
                `[compaction] Context at ${pct.toFixed(1)}% (${est}tokens / ${contextWindowTokens}tokens) — ${kind}`,
              );
            };

            const runCompressAndRebuild = async (
              compressReason: string,
            ): Promise<{ ok: boolean; tokensBefore?: number; tokensAfter?: number; status?: string }> => {
              const providerId =
                getEffectiveModelForOptions(settings)?.provider ??
                (settings.selectedModel?.provider ?? undefined);
              const { executeCompressContext } = await import("@/lib/tools/workspace");
              const { getStreamTransport } = await import("@/lib/chat/stream-transport");
              const msgListR = updatedChat.messages as {
                id: number;
                role: string;
                content: string;
              }[];
              const outcomeR = await executeCompressContext(
                { reason: compressReason },
                {
                  chatId: req.chatId,
                  messages: msgListR.map((m) => ({
                    id: m.id,
                    role: m.role,
                    content: m.content || "",
                  })),
                  // W6: the stream's REAL system prompt is in scope — no more
                  // hardcoded 6000 (the ratio gate now sees the meter's scope).
                  systemPromptTokens: estimateTokens(systemPrompt),
                  inputTokens: estimateTokens(userPrompt),
                  providerId,
                  sessionStats: { toolCallCount: 0, delegationCount: 0 },
                  // Thread the known-good session id (as the other two compress
                  // call sites do) so the compaction marker persists — else a
                  // reload re-loads FULL history and re-summarizes on the first
                  // post-reload turn.
                  workspaceSessionId: req.workspaceSessionId ?? undefined,
                  setMessages: (next) => {
                    updatedChat.messages = next as typeof updatedChat.messages;
                    const ec = getStreamTransport(req.chatId);
                    if (ec) ec.messages = next as typeof ec.messages;
                  },
                },
              );
              if (!(outcomeR.success && outcomeR.status === "completed")) {
                return {
                  ok: false,
                  tokensBefore: outcomeR.tokensBefore,
                  tokensAfter: outcomeR.tokensAfter,
                  status: outcomeR.status,
                };
              }
              {
                type EphemeralMsgR = {
                  role: string;
                  content?: string;
                  sourceCommitHash?: string;
                  commitHash?: string;
                };
                limitedMessageHistory = (updatedChat.messages as EphemeralMsgR[]).map((message) => {
                  const content = message.content || "";
                  const baseMessage: {
                    role: "user" | "assistant" | "system";
                    content: string;
                  } = {
                    role: message.role as "user" | "assistant" | "system",
                    content,
                  };
                  const commitFields: { sourceCommitHash?: string; commitHash?: string } = {};
                  if (message.sourceCommitHash) {
                    commitFields.sourceCommitHash = message.sourceCommitHash;
                  }
                  if (message.commitHash) {
                    commitFields.commitHash = message.commitHash;
                  }
                  return { ...baseMessage, ...commitFields };
                });
                // No count-based cap here either — the token budget below is the
                // only thing permitted to shrink history.
              }
              // `contextSummaryForSystem` is hardcoded `null` at
              // chat_stream_handlers.ts and threaded through unchanged, so the
              // re-insert branch that used to sit here never ran. The filter stays:
              // it is what removes a section a PREVIOUS build may have added.
              contextSections = contextSections.filter((s) => s.name !== "contextSummary");
              workingSections = [...contextSections];
              promptBundle = await buildPromptBundle(workingSections, promptBundleDeps);
              ({
                systemPrompt,
                contextAssemblerBlob,
                codebasePrefix,
                otherCodebasePrefix,
              } = promptBundle);
              const tierBudgetedR = await enforceContextBudget({
                settings,
                effectiveModel,
                userPrompt,
                systemPrompt,
                contextAssemblerBlob,
                limitedMessageHistory,
                codebasePrefixMessages: [...codebasePrefix],
                otherCodebasePrefixMessages: [...otherCodebasePrefix],
                toolSurfaceTokens,
              });
              systemPrompt = tierBudgetedR.systemPrompt;
              limitedMessageHistory = tierBudgetedR.limitedMessageHistory;
              contextAssemblerBlob = tierBudgetedR.contextAssemblerBlob;
              dispatchEstimate = estimateDispatchTokens({
                systemPrompt,
                history: limitedMessageHistory,
                codebasePrefixMessages: [...codebasePrefix],
                otherCodebasePrefixMessages: [...otherCodebasePrefix],
                toolSurfaceTokens,
              });
              budgetTracker = new ContextBudgetTracker(
                modelContextResolved.tierLimit,
                dispatchEstimate,
              );
              return {
                ok: true,
                tokensBefore: outcomeR.tokensBefore,
                tokensAfter: outcomeR.tokensAfter,
                status: outcomeR.status,
              };
            };

            /** Bounded retries for the one pre-dispatch gate (was the 0.90 block's 3). */
            const MAX_COMPACTION_PASSES = 3;

            // THE pre-dispatch compaction trigger. One gate, one threshold.
            //
            // This was TWO near-identical blocks — 0.75 ("proactive") and 0.90
            // ("forced", looping up to 3 times) — each logging, emitting the same
            // pair of activity events and calling the same `runCompressAndRebuild`.
            // Two thresholds for one decision, so "when does Atlarix compact" had a
            // different answer depending on which block noticed first, and the 0.90
            // block could only ever run after the 0.75 one had already compacted.
            // Collapsed to a single gate at COMPACTION_THRESHOLD with the retry
            // kept: re-measure after each pass and stop as soon as we are under.
            //
            // Always on. This used to be opt-out, and opting out did not mean
            // "keep everything" — it meant the old count cap deleted turns
            // outright instead. Summarizing is unconditionally better than that.
            //
            // WHY THIS STAYS THE MECHANISM, rather than folding into
            // `enforceContextBudget`: only this path can compact the LIVE
            // TRANSPORT. `executeCompressContext`'s `setMessages` replaces the
            // ephemeral chat's messages, so the shrink survives into later turns
            // and the durable `[COMPACTION MARKER]` is written for the reload.
            // `enforceContextBudget` only ever shrinks the per-request copy, which
            // is why the compaction call added there in the previous pass has been
            // removed as the weaker, redundant half. It keeps the jobs only it can
            // do: trimming the context-assembler blob out of the system prompt, and
            // dropping head messages as a last resort with a notice to the model.
            // `usableTokens` is the window MINUS the reply reserve, resolved from
            // the model's real output limit. Comparing against it directly retires
            // the flat 0.9, which reserved ~68,000 tokens too many on a 1M window
            // and far too few on a small one.
            const fillBefore = dispatchEstimate / contextWindowTokens;
            if (dispatchEstimate > usableTokens) {
              logCompactionLine(dispatchEstimate, "compact");
              logger.log(
                `[stream:${req.chatId}] pre-dispatch context compaction fill=${(fillBefore * 100).toFixed(1)}% est=${dispatchEstimate} usable=${usableTokens} window=${contextWindowTokens}`,
              );
              const activityBase = `predispatch-compact-${req.chatId}-${Date.now()}`;
              // THE TRIGGER THAT HAD NO UI. This site emitted only
              // `type: "compaction"`, which the renderer drops by design, and
              // never the `background` event the mid-stream pill reads — so the
              // one compaction a user never asked for was also the only one that
              // happened silently, reported with the ring pinned at 100%.
              // `emitCompactionActivity` sends both, for every trigger.
              // ONE id for both legs — see emitCompactionActivity. The `-run` /
              // `-done` suffixes here were what left two rows in the transcript.
              emitCompactionActivity(event.sender, req.chatId, {
                id: activityBase,
                trigger: "automatic",
                status: "running",
                detail: `context at ${Math.round(fillBefore * 100)}%`,
              });
              let lastResult: Awaited<ReturnType<typeof runCompressAndRebuild>> | null =
                null;
              try {
                // Bounded: a history that cannot be compressed further must not
                // spin. `runCompressAndRebuild` recomputes `dispatchEstimate`, so
                // the loop condition sees each pass's real effect.
                for (let pass = 0; pass < MAX_COMPACTION_PASSES; pass++) {
                  if (dispatchEstimate <= usableTokens) break;
                  const cr = await runCompressAndRebuild(
                    `pre-dispatch-fill-${Math.round(
                      (dispatchEstimate / contextWindowTokens) * 100,
                    )}%`,
                  );
                  lastResult = cr;
                  if (!cr.ok) break;
                }
              } catch (e) {
                logger.warn(`[stream:${req.chatId}] pre-dispatch compaction failed`, e);
              }
              emitCompactionActivity(event.sender, req.chatId, {
                id: activityBase,
                trigger: "automatic",
                status: lastResult?.ok ? "done" : "error",
                noop: lastResult?.status === "noop",
                detail:
                  typeof lastResult?.tokensBefore === "number" &&
                  typeof lastResult?.tokensAfter === "number"
                    ? `${lastResult.tokensBefore} → ${lastResult.tokensAfter} tokens`
                    : undefined,
              });
            }

            const CONTEXT_PROACTIVE_THRESHOLD = 0.55;
            const fillAfterProactive = dispatchEstimate / contextWindowTokens;
            if (fillAfterProactive >= CONTEXT_PROACTIVE_THRESHOLD) {
              const livePct = Math.round(fillAfterProactive * 100);
              logCompactionLine(dispatchEstimate, "reminder");
              proactiveContextReminderForStream = `Context is at ${livePct}% capacity. Consider calling compress_context before your next heavy tool use.`;
            }
            // Context meter: report the ACTUAL model-facing dispatched size
            // (post compaction/slice) + window so the UI shows what the model
            // sees and DROPS after a summarize, instead of the full untrimmed
            // conversation count. Sections/trims came from the earlier report;
            // the renderer (useContextReport) merges these dispatched fields in.
            if (process.env.ATLARIX_DIAG_146 === "1") {
              logger.info(
                `[DIAG_146] per-dispatch context-report chat=${req.chatId} dispatchedTokens=${dispatchEstimate} window=${contextWindowTokens}`,
              );
            }
            safeSend(event.sender, "chat:context-report", {
              chatId: req.chatId,
              sections: [],
              trimReport: [],
              dispatchedTokens: dispatchEstimate,
              contextWindow: contextWindowTokens,
            } satisfies ChatContextReport);
  return {
    systemPrompt,
    limitedMessageHistory,
    contextAssemblerBlob,
    codebasePrefix,
    otherCodebasePrefix,
    dispatchEstimate,
    budgetTracker,
    workingSections,
    promptBundle,
    contextSections,
    proactiveContextReminderForStream,
  };
}
