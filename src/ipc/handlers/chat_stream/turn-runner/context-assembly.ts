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
  contextSummaryForSystem: string | null;
  contextWindowTokens: number;
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
    contextSummaryForSystem,
    contextWindowTokens,
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
            let loggedCompactionRem55 = false;
            let loggedCompactionAuto75 = false;
            let loggedCompactionForced90 = false;
            const logCompactionLine = (
              est: number,
              kind: "reminder" | "auto" | "forced",
              gate: 55 | 75 | 90,
            ) => {
              const pct = (est / contextWindowTokens) * 100;
              if (gate === 55 && loggedCompactionRem55) return;
              if (gate === 75 && loggedCompactionAuto75) return;
              if (gate === 90 && loggedCompactionForced90) return;
              if (gate === 55) loggedCompactionRem55 = true;
              if (gate === 75) loggedCompactionAuto75 = true;
              if (gate === 90) loggedCompactionForced90 = true;
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
              contextSections = contextSections.filter((s) => s.name !== "contextSummary");
              if (contextSummaryForSystem) {
                contextSections.push({
                  name: "contextSummary",
                  priority: 5,
                  content: `## Session Summary (earlier conversation)\n${contextSummaryForSystem}`,
                });
              }
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
                // Durability: without these the summary this call may pay for is
                // discarded at end of turn and re-bought on the next one.
                chatId: req.chatId,
                workspaceSessionId: req.workspaceSessionId,
              });
              systemPrompt = tierBudgetedR.systemPrompt;
              limitedMessageHistory = tierBudgetedR.limitedMessageHistory;
              contextAssemblerBlob = tierBudgetedR.contextAssemblerBlob;
              dispatchEstimate = estimateDispatchTokens({
                systemPrompt,
                history: limitedMessageHistory,
                codebasePrefixMessages: [...codebasePrefix],
                otherCodebasePrefixMessages: [...otherCodebasePrefix],
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

            // Always on. This used to be opt-out, and opting out did not mean
            // "keep everything" — it meant the old count cap deleted turns
            // outright instead. Summarizing is unconditionally better than that.
            const fillRatioBefore = dispatchEstimate / contextWindowTokens;
            if (fillRatioBefore >= 0.75) {
              {
                const reason = "proactive-fill-75%";
                logCompactionLine(dispatchEstimate, "auto", 75);
                logger.log(
                  `[stream:${req.chatId}] proactive context compaction (${reason}) fill=${(fillRatioBefore * 100).toFixed(1)}% est=${dispatchEstimate}/${contextWindowTokens}`,
                );
                const activityBase = `proactive-compact-${req.chatId}-${Date.now()}`;
                safeSend(event.sender, "chat:activity", {
                  id: `${activityBase}-run`,
                  type: "compaction",
                  label: "Context compacted automatically",
                  status: "running",
                  timestamp: Date.now(),
                  detail: reason,
                  chatId: req.chatId,
                  modelInitiated: false,
                });
                try {
                  const cr = await runCompressAndRebuild(reason);
                  safeSend(event.sender, "chat:activity", {
                    id: `${activityBase}-done`,
                    type: "compaction",
                    label: "Context compacted automatically",
                    status: cr.ok ? "done" : "error",
                    timestamp: Date.now(),
                    detail:
                      typeof cr.tokensBefore === "number" && typeof cr.tokensAfter === "number"
                        ? `${cr.tokensBefore} → ${cr.tokensAfter} est. (${String(cr.status ?? "")})`
                        : String(cr.status ?? "noop"),
                    chatId: req.chatId,
                    modelInitiated: false,
                  });
                } catch (e) {
                  safeSend(event.sender, "chat:activity", {
                    id: `${activityBase}-err`,
                    type: "compaction",
                    label: "Context compacted automatically",
                    status: "error",
                    timestamp: Date.now(),
                    detail: String(e),
                    chatId: req.chatId,
                    modelInitiated: false,
                  });
                  logger.warn(`[stream:${req.chatId}] proactive compaction failed`, e);
                }
              }
            }
            const fillAfter75 = dispatchEstimate / contextWindowTokens;
            if (fillAfter75 >= 0.9) {
              {
                logCompactionLine(dispatchEstimate, "forced", 90);
                const forcedBase = `forced-compact-${req.chatId}-${Date.now()}`;
                safeSend(event.sender, "chat:activity", {
                  id: `${forcedBase}-run`,
                  type: "compaction",
                  label: "Compacting context before continuing...",
                  status: "running",
                  timestamp: Date.now(),
                  detail: "forced-fill-90%",
                  chatId: req.chatId,
                  modelInitiated: false,
                });
                let forcedAny = false;
                try {
                  for (let fi = 0; fi < 3; fi++) {
                    if (dispatchEstimate / contextWindowTokens < 0.9) break;
                    const crF = await runCompressAndRebuild("forced-fill-90%");
                    if (!crF.ok) break;
                    forcedAny = true;
                  }
                } catch (forcedErr) {
                  logger.warn(`[stream:${req.chatId}] forced compaction failed`, forcedErr);
                }
                safeSend(event.sender, "chat:activity", {
                  id: `${forcedBase}-done`,
                  type: "compaction",
                  label: "Compacting context before continuing...",
                  status: forcedAny ? "done" : "error",
                  timestamp: Date.now(),
                  chatId: req.chatId,
                  modelInitiated: false,
                });
              }
            }

            const CONTEXT_PROACTIVE_THRESHOLD = 0.55;
            const fillAfterProactive = dispatchEstimate / contextWindowTokens;
            if (fillAfterProactive >= CONTEXT_PROACTIVE_THRESHOLD) {
              const livePct = Math.round(fillAfterProactive * 100);
              logCompactionLine(dispatchEstimate, "reminder", 55);
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
