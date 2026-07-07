/**
 * simpleStreamText — builds provider options + the streamText dispatch for one
 * model round, extracted verbatim from runStream. Returns the live stream
 * bundle (fullStream/usage/finishReason/response + getResumeMessages for
 * stall-resume). Reads its enclosing config as an explicit `deps` object; the
 * per-turn mutable accumulators/tallies live on `ctx`.
 *
 * (Satellite: never imports the parent handler.)
 */

import log from "electron-log";
import type { IpcMainInvokeEvent } from "electron";
import { streamText, stepCountIs } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import type { CodebaseFile } from "@/utils/codebase";
import type {
  SmartContextMode,
  UserSettings,
  LargeLanguageModel,
} from "@/lib/schemas";
import type { ChatStreamParams } from "@/ipc/ipc_types";
import type { AgenticRepetitionState } from "@/lib/streaming/agentic-loop-repetition";
import { PreflightTimer } from "@/lib/agent/preflight-timing";
import { ContextBudgetTracker } from "@/lib/context/context-budget-tracker";
import {
  getEffectiveModelForOptions,
  type ModelClient,
} from "@/ipc/utils/get_model_client";
import { shouldStopForCompassLimit } from "@/lib/auth/compass_enforcement";
import {
  recordCompassUsageTokens,
  reasoningTokensFromAiUsage,
  totalTokensFromAiUsage,
} from "@/lib/auth/compass_usage";
import { COMPASS_REACHABILITY_ERROR } from "@/ipc/shared/compass_constants";
import {
  getNativeWebSearchSupport,
  reservedNativeToolNames,
} from "@/ipc/utils/native_web_search";
import {
  attachEmptyOutputSafeRejectHandlers,
  isNoUsableModelOutputError,
} from "@/ipc/utils/no_usable_model_output";
import { safeSend } from "@/ipc/utils/safe_sender";
import {
  getExtraProviderOptions,
  getReasoningEffort,
} from "@/ipc/utils/thinking_utils";
import {
  getMaxTokensWithFloor,
  getTemperature,
} from "@/ipc/utils/token_utils";
import {
  processChatMessagesWithVersionedFiles as getVersionedFiles,
  type VersionedFiles,
} from "@/ipc/utils/versioned_codebase_context";
import { isNetworkStreamError } from "@/ipc/handlers/chat_stream/network-retry";
import { sentryCaptureExceptionSafe } from "@/ipc/handlers/chat_stream/sentry-safe";
import {
  activeStreams,
  activeStreamId,
} from "@/ipc/handlers/chat_stream/stream-state";
import {
  takePendingBackgroundCommandResults,
  takePendingStalledAdvisories,
} from "@/lib/agent/background-commands";
import { collectPendingBackgroundResultsBody } from "@/lib/agent/collect-results";
import { takePendingScheduledWakeupNudges } from "@/lib/agent/scheduled-wakeups";
import { takePendingSubagentResults } from "@/lib/agents/subagent-results";
import {
  advanceCacheBreakpointsForStep,
  buildStreamMessagesWithCacheBreakpoints,
  resolveCacheMarkerPlacement,
} from "@/lib/ai/anthropic-cache-breakpoints";
import { mergeSystemPromptParts } from "@/lib/ai/merge-system-prompt";
import { normalizeToolInputSchemaForAiSdk } from "@/lib/ai/normalize-tool-schema";
import { perfReportOnce } from "@/lib/perf-marks";
import { inputOutputTokensFromUsage } from "@/lib/routing/byok-pricing";
import {
  buildReasoningProviderOptions,
  detectReasoningCapability,
  resolveReasoningCatalogModelId,
  deriveReasoningCeiling,
} from "@/lib/routing/reasoning-detector";
import { systemReminder } from "@/lib/streaming/system-reminder";
import {
  AI_STREAMING_ERROR_MESSAGE_PREFIX,
  modelFailureUserMessage,
} from "@/shared/texts";
import type { StreamTurnContext } from "@/ipc/handlers/chat_stream/turn-context";

const logger = log.scope("chat_stream_handlers");

export interface SimpleStreamTextArgs {
  chatMessages: ModelMessage[];
  modelClient: ModelClient;
  files: CodebaseFile[];
  tools?: ToolSet;
  systemPromptOverride?: string;
  /** PASS8 A5: prepended as a system-role message so the static `system`
   * field stays cache-eligible across turns. */
  dynamicSystemTail?: string;
  dyadDisableFiles?: boolean;
  /** Per-round abort signal — stall watchdog aborts this round only, leaving
   * the shared turn controller usable for a retry. */
  abortSignalOverride?: AbortSignal;
  /** Mode's repetition guard — enables mid-round correction reinject. */
  repetition?: AgenticRepetitionState;
  /** Backstop in-round step cap (opencode `agent.steps`); undefined = unbounded. */
  maxStepsPerRound?: number;
}

export interface SimpleStreamTextDeps {
  req: ChatStreamParams;
  settings: UserSettings;
  updatedChat: any;
  effectiveAppId: number | undefined;
  effectiveModel: LargeLanguageModel;
  appPath: string;
  engineRequestId: string | undefined;
  isEngineEnabled: boolean | undefined;
  isDeepContextEnabled: boolean | undefined;
  enableNativeReasoning: boolean;
  forceCollectOnWake: boolean;
  proactiveContextReminderForStream: string | undefined;
  modeReanchorNote: string;
  taskLedgerBlock: string | null;
  systemPrompt: string;
  budgetTracker: ContextBudgetTracker;
  streamId: number;
  event: IpcMainInvokeEvent;
  placeholderAssistantMessage: any;
  preflight: PreflightTimer;
  stopStreamForCompassLimit: (origin: string) => void;
  ttftStartRef: { ms: number | null };
  abortController: AbortController;
}

export async function simpleStreamText(
  ctx: StreamTurnContext,
  deps: SimpleStreamTextDeps,
  {
    chatMessages,
    modelClient,
    tools,
    systemPromptOverride = deps.systemPrompt,
    dynamicSystemTail,
    dyadDisableFiles = false,
    files,
    repetition,
    abortSignalOverride,
    maxStepsPerRound,
  }: SimpleStreamTextArgs,
) {
  const {
    req,
    settings,
    updatedChat,
    effectiveAppId,
    effectiveModel,
    appPath,
    engineRequestId,
    isEngineEnabled,
    isDeepContextEnabled,
    enableNativeReasoning,
    forceCollectOnWake,
    proactiveContextReminderForStream,
    modeReanchorNote,
    taskLedgerBlock,
    budgetTracker,
    streamId,
    event,
    placeholderAssistantMessage,
    preflight,
    stopStreamForCompassLimit,
    ttftStartRef,
    abortController,
  } = deps;
            if (isEngineEnabled) {
              logger.log(
                "sending AI request to engine with request id:",
                engineRequestId,
              );
            } else {
              logger.log("sending AI request");
            }
            let versionedFiles: VersionedFiles | undefined;
            if (isDeepContextEnabled) {
              versionedFiles = await preflight.time("versioned-files", () =>
                getVersionedFiles({
                  files,
                  chatMessages,
                  appPath,
                }),
              );
            }
            const smartContextMode: SmartContextMode = isDeepContextEnabled
              ? "deep"
              : "balanced";
            const optionsModel = getEffectiveModelForOptions(settings);
            const thinkingTier = enableNativeReasoning;
            // Resolve the max output tokens ONCE — reused to scale the reasoning
            // budget (below) AND as streamText's maxOutputTokens (~line 3953),
            // avoiding a duplicate catalog lookup.
            const maxOutputTokens = await preflight.time("max-tokens", () =>
              getMaxTokensWithFloor(optionsModel, {
                reasoningCapable: enableNativeReasoning,
              }),
            );
            const providerOptions: Record<string, any> = {
              "dyad-engine": {
                dyadAppId: effectiveAppId ?? updatedChat.app?.id,
                dyadRequestId: engineRequestId,
                dyadDisableFiles,
                dyadSmartContextMode: smartContextMode,
                dyadFiles: versionedFiles ? undefined : files,
                dyadVersionedFiles: versionedFiles,
              },
              "dyad-gateway": getExtraProviderOptions(
                modelClient.builtinProviderId,
                settings,
                thinkingTier,
                maxOutputTokens,
              ),
            };

            // OpenRouter provider-routing pin (benchmarks: lock one provider +
            // quantization so the backend is identical across harnesses).
            // ATLARIX_OPENROUTER_PROVIDER_JSON = e.g.
            //   {"order":["deepinfra"],"allow_fallbacks":false,"quantizations":["fp8"]}
            if (modelClient.builtinProviderId === "openrouter") {
              const pinJson = process.env.ATLARIX_OPENROUTER_PROVIDER_JSON;
              if (pinJson) {
                try {
                  providerOptions.openrouter = {
                    ...providerOptions.openrouter,
                    provider: JSON.parse(pinJson),
                  };
                } catch (e) {
                  logger.warn(
                    `Ignoring invalid ATLARIX_OPENROUTER_PROVIDER_JSON: ${e instanceof Error ? e.message : String(e)}`,
                  );
                }
              }
            }

            const useOpenRouterContextCompression =
              (modelClient.builtinProviderId === "openrouter" ||
                modelClient.builtinProviderId === "compass") &&
              (budgetTracker.isCritical() || budgetTracker.isOverLimit());
            if (useOpenRouterContextCompression) {
              providerOptions.openrouter = {
                plugins: [{ id: "context-compression" }],
              };
            }

            // Reasoning / native thoughts only for the thinking context tier (dynamic per model).
            if (thinkingTier) {
              const catalogModelId = resolveReasoningCatalogModelId(effectiveModel);
              const cap = detectReasoningCapability(
                catalogModelId,
                modelClient.builtinProviderId,
              );
              const reasoningPatch = buildReasoningProviderOptions(
                cap,
                true,
                getReasoningEffort(
                  settings,
                  deriveReasoningCeiling(
                    effectiveModel,
                    modelClient.builtinProviderId,
                  ),
                ),
                maxOutputTokens,
              );
              if (reasoningPatch.openrouter) {
                providerOptions.openrouter = {
                  ...providerOptions.openrouter,
                  ...reasoningPatch.openrouter,
                };
              }
              if (reasoningPatch.google) {
                // ai@6 renamed the Vertex provider-options key google → vertex.
                const googleKey =
                  modelClient.builtinProviderId === "vertex" ? "vertex" : "google";
                providerOptions[googleKey] = reasoningPatch.google;
              }
              if (reasoningPatch.openai) {
                // ai@6 renamed the Azure provider-options key openai → azure.
                const openaiKey =
                  modelClient.builtinProviderId === "azure" ? "azure" : "openai";
                providerOptions[openaiKey] = reasoningPatch.openai;
              }
            }

            const isAnthropic = modelClient.builtinProviderId === "anthropic";
            // v13.2: explicit cache markers for Claude-family models on EVERY
            // route (OpenRouter/Compass/Bedrock/custom proxies) — they get no
            // caching without them. Automatic-caching providers resolve "none".
            const cacheMarkerPlacement = resolveCacheMarkerPlacement(
              modelClient.builtinProviderId,
              effectiveModel?.name,
            );
            // OpenAI prefix caching is automatic; a stable per-chat cache key
            // improves cache-routing affinity on their side. v13.3: 24h
            // extended retention (free) on the models that support it.
            if (modelClient.builtinProviderId === "openai") {
              providerOptions.openai = {
                ...providerOptions.openai,
                promptCacheKey: `atlarix-chat-${req.chatId}`,
                ...(/^gpt-5\.[1-9]/i.test(effectiveModel?.name ?? "")
                  ? { promptCacheRetention: "24h" }
                  : {}),
              };
            }

            // v10.1: provider-native web search — when the provider ships a
            // built-in search tool, swap out the client-side `web_search` for
            // it (results + citations come back inline in the same stream).
            // Client `web_search` stays the universal fallback elsewhere.
            let effectiveTools = tools;
            if (tools && tools["web_search"]) {
              const nativeWeb = getNativeWebSearchSupport(
                modelClient.builtinProviderId,
                effectiveModel?.name,
              );
              if (nativeWeb) {
                // Provider-agnostic: a native web search supersedes the client
                // `web_search` for ALL providers. Strip every client tool whose
                // name the provider will inject (covers the OpenRouter `web`
                // plugin's server-side web_search — the xAI/Grok duplicate bug),
                // then add the native tool / enable the plugin.
                const reserved = new Set(reservedNativeToolNames(nativeWeb));
                effectiveTools = Object.fromEntries(
                  Object.entries(tools).filter(([name]) => !reserved.has(name)),
                );
                if (nativeWeb.kind === "tool") {
                  effectiveTools[nativeWeb.key] = nativeWeb.tool;
                } else if (nativeWeb.kind === "openrouter-plugin") {
                  providerOptions.openrouter = {
                    ...providerOptions.openrouter,
                    plugins: [
                      ...(providerOptions.openrouter?.plugins ?? []),
                      { id: "web" },
                    ],
                  };
                }
                logger.log(
                  `[native-web-search] ${nativeWeb.kind} active (${modelClient.builtinProviderId}); dropped client tools: ${[...reserved].join(", ")}`,
                );
              }
            }

            // R2: on an auto-wake continuation turn that has finished background /
            // sub-agent results (or a stall advisory) waiting, deliver them as a
            // REAL tool-result (persisted via native history) by adding an
            // internal `collect_results` tool and FORCING the first step to call
            // it — a harness guarantee a weak model can't skip. Gated on
            // `forceCollectOnWake` (NOT `wakeHasPendingResults`): in thinking mode
            // a forced tool_choice is provider-rejected, so we skip the forced
            // tool and let the prepareStep injection deliver instead.
            if (forceCollectOnWake) {
              effectiveTools = {
                ...effectiveTools,
                collect_results: {
                  description:
                    "Collect the results of background work that finished while you were away, then act on them.",
                  inputSchema: normalizeToolInputSchemaForAiSdk({
                    type: "object",
                    properties: {},
                  }) as never,
                  execute: async () =>
                    collectPendingBackgroundResultsBody(req.chatId),
                },
              };
            }

            // maxOutputTokens is resolved earlier (hoisted for reasoning-budget
            // scaling) — reused here.
            const temperature = await preflight.time("temperature", () =>
              getTemperature(optionsModel),
            );

            ttftStartRef.ms = Date.now();
            // v10.1 perf: time from workspace open to the first prompt dispatch.
            if (effectiveAppId != null) {
              perfReportOnce(
                `workspace-open:${effectiveAppId}`,
                `workspace ${effectiveAppId} open → first prompt dispatch`,
              );
            }
            // v12 S17: pre-flight waterfall — first dispatch of the turn only.
            preflight.reportOnce(req.chatId);

            const history: ModelMessage[] = chatMessages.filter((m) => m.content);
            // v13.3: the 55% compress-context reminder no longer rides the
            // dynamic tail (its appearance mid-session re-wrote the prefix
            // once). It's delivered via the prepareStep injection seam below
            // (take-once, step-input-only — same contract as corrections).
            const tailParts = [dynamicSystemTail].filter(
              (s): s is string => typeof s === "string" && s.trim().length > 0,
            );
            let pendingContextReminder: string | null =
              proactiveContextReminderForStream ?? null;

            // v10.1 prompt caching: the per-turn tail no longer merges into the
            // `system` string (that invalidated the provider prompt cache every
            // turn). Layout + Anthropic breakpoints live in
            // buildStreamMessagesWithCacheBreakpoints (unit-tested).
            const streamMessages: ModelMessage[] =
              buildStreamMessagesWithCacheBreakpoints({
                systemHeader: systemPromptOverride,
                dynamicTail:
                  tailParts.length > 0
                    ? mergeSystemPromptParts(tailParts[0], ...tailParts.slice(1))
                    : null,
                history,
                placement: cacheMarkerPlacement,
                // v13.3: header prefix survives >5min between-turn gaps.
                headerTtl1h: isAnthropic,
              });
            // Continue-from-partial (stall recovery): accumulate each COMPLETED
            // step's native messages (assistant tool-call + tool-result pairs) so
            // a mid-stream stall can RESUME from the work already done instead of
            // restarting the round and re-running every tool call (the old
            // "redoing the whole task" symptom). Populated incrementally in
            // onStepFinish and backstopped by onAbort (authoritative at abort).
            // Passive on the happy path — only read on a genuine stall.
            const completedStepMessages: ModelMessage[] = [];
            const recordStepMessages = (
              msgs: readonly ModelMessage[] | undefined,
            ) => {
              if (msgs && msgs.length) completedStepMessages.push(...msgs);
            };
            const streamResult = streamText({
              headers: isAnthropic
                ? {
                  "anthropic-beta": "context-1m-2025-08-07",
                }
                : modelClient.builtinProviderId === "openrouter" ||
                    modelClient.builtinProviderId === "compass"
                  ? {
                    // v13.3: sticky provider routing — pins the upstream from
                    // the first request so prompt-cache reads land on the same
                    // provider instance (openrouter.ai prompt-caching guide).
                    "x-session-id": `atlarix-chat-${req.chatId}`,
                  }
                  : undefined,
              maxOutputTokens,
              temperature,
              maxRetries:
                tools != null && Object.keys(tools as object).length > 0 ? 0 : 2,
              model: modelClient.model,
              // Backstop for the abort() in stopStreamForCompassLimit: even if
              // the abort races a step boundary, the multi-step loop must not
              // start another step once the token pool is exhausted. The
              // optional step cap (interactive build only) bounds an in-round
              // runaway so it returns to the round boundary instead of spinning
              // unbounded — undefined leaves headless/ask uncapped.
              stopWhen:
                typeof maxStepsPerRound === "number" && maxStepsPerRound > 0
                  ? [() => ctx.compassLimitHit, stepCountIs(maxStepsPerRound)]
                  : [() => ctx.compassLimitHit],
              // v12 0.1 close-out: mid-round correction reinject. Repetition
              // corrections are queued inside the SDK's multi-step inner loop
              // (the tool wrappers call record() during execute), where the
              // round-boundary injection can't reach until the round ends.
              // prepareStep runs before EVERY step — when a correction is
              // pending, append it as a user message so the model sees it on
              // the very next step. takePendingCorrection() is take-once, so
              // the engine's round-boundary injection stays a non-duplicating
              // fallback (text-tool path / correction queued on a final step).
              // The injected message is step-input only — it never enters
              // response.messages, so native-history folding (B1/B2) is
              // unaffected (transient steering nudge, not persisted history).
              prepareStep: ({ messages, stepNumber }) => {
                // v13 7A: finished background-command results land on the very
                // next step (same step-input-only contract as corrections).
                // R2: when the wake turn uses the FORCED collect_results tool
                // (forceCollectOnWake), do NOT also drain here (would
                // double-consume / leave collect_results empty). Otherwise — the
                // live mid-turn path AND thinking-mode wake turns (where the
                // forced tool is provider-rejected) — the results are delivered
                // HERE via injection.
                const bgResults = forceCollectOnWake
                  ? null
                  : takePendingBackgroundCommandResults(req.chatId);
                // Finished background sub-agent results fold in the same way —
                // each one as it arrives, even one at a time.
                const subagentResults = forceCollectOnWake
                  ? null
                  : takePendingSubagentResults(req.chatId);
                // A4: stall advisories for still-running quiet jobs (decide:
                // keep waiting / read / cancel) — same step-input-only seam.
                const stalledAdvisories = forceCollectOnWake
                  ? null
                  : takePendingStalledAdvisories(req.chatId);
                const correction = repetition
                  ? repetition.takePendingCorrection()
                  : null;
                // v13.3: the 55% reminder rides this seam now (take-once) so
                // the system tail stays byte-stable for the prompt cache.
                const reminder = pendingContextReminder;
                pendingContextReminder = null;
                // R1: a fired self-wake delivers a soft "re-check now" nudge here
                // (guidance by nature — NOT a forced tool-result like R2's results).
                const scheduledNudge = takePendingScheduledWakeupNudges(req.chatId);
                // #15: re-anchor the active mode at the START of the turn (step 0)
                // so it's the last thing before the model acts. Ephemeral /
                // step-input-only like the other nudges — never persisted.
                // #A1/#A4: the compact task ledger rides the same step-0 recency
                // slot (just before the mode re-anchor) — carries the active goal
                // (in-progress step) so mode+goal are both freshly re-asserted.
                const modeReanchor = stepNumber === 0 ? modeReanchorNote : null;
                const taskLedger = stepNumber === 0 ? taskLedgerBlock : null;
                // #12: targeted empty-output nudge (take-once), set by the retry.
                const emptyOutputNudge = ctx.pendingEmptyOutputNudge;
                ctx.pendingEmptyOutputNudge = null;
                if (correction) {
                  logger.log(
                    `[repetition] injecting mid-round correction (chat ${req.chatId})`,
                  );
                }
                if (bgResults) {
                  logger.log(
                    `[background-command] injecting finished result (chat ${req.chatId})`,
                  );
                }
                if (subagentResults) {
                  logger.log(
                    `[background-subagent] injecting finished result (chat ${req.chatId})`,
                  );
                }
                const injected = [
                  reminder,
                  bgResults,
                  subagentResults,
                  stalledAdvisories,
                  scheduledNudge,
                  correction,
                  emptyOutputNudge,
                  // Task ledger + mode re-anchor LAST so they are the final
                  // things the model reads before it acts.
                  taskLedger,
                  modeReanchor,
                ]
                  .filter(Boolean)
                  .join("\n\n");
                // v14.8.8: frame the whole harness-injected block as out-of-band
                // so a recency-biased model never reads these nudges as a fresh
                // user request (only genuine user turns stay untagged).
                const stepMessages = injected
                  ? [...messages, { role: "user" as const, content: systemReminder(injected) }]
                  : messages;
                // v13.3: per-step breakpoint advancement — without it, every
                // step re-pays full price for the turn's accumulated tool
                // results (opencode gets this free by re-running its message
                // transform per request). Step 0 is a no-op vs the initial
                // layout, so skip the copy unless something changed.
                // R2: force the model's FIRST step on a wake turn to call
                // collect_results, so the pending results arrive as a real
                // (persisted) tool-result. A forced toolChoice is a hard harness
                // constraint — a weak model cannot skip it. Subsequent steps run
                // free (the model then acts on the collected results).
                const forceCollect = forceCollectOnWake && stepNumber === 0;
                const base =
                  cacheMarkerPlacement !== "none" && (stepNumber > 0 || injected)
                    ? {
                        messages: advanceCacheBreakpointsForStep(
                          stepMessages,
                          cacheMarkerPlacement,
                        ),
                      }
                    : injected
                      ? { messages: stepMessages }
                      : undefined;
                if (forceCollect) {
                  return {
                    ...(base ?? { messages }),
                    toolChoice: {
                      type: "tool" as const,
                      toolName: "collect_results",
                    },
                  };
                }
                return base;
              },
              providerOptions,
              tools: effectiveTools,
              messages: streamMessages,
              // v11 strict Core enforcement: record + check usage at every step
              // boundary (the SDK awaits this before the next step), so a turn
              // stops immediately mid-task when the monthly pool runs out.
              // This also fixes the old undercount where only the final step's
              // usage was recorded for multi-step turns.
              onStepFinish: async (step) => {
                // Capture this step's native messages for stall-resume BEFORE any
                // provider-specific early return below.
                recordStepMessages(
                  step.response?.messages as
                    | readonly ModelMessage[]
                    | undefined,
                );
                if (modelClient.builtinProviderId !== "compass") return;
                const stepTokens = totalTokensFromAiUsage(step.usage) ?? 0;
                let recordResult = null;
                if (stepTokens > 0) {
                  ctx.compassUsedThisTurn += stepTokens;
                  ctx.compassStreamTokens = (ctx.compassStreamTokens ?? 0) + stepTokens;
                  recordResult = await recordCompassUsageTokens(stepTokens);
                }
                if (
                  shouldStopForCompassLimit(
                    {
                      remainingBudget: ctx.compassRemainingBudget,
                      usedThisTurn: ctx.compassUsedThisTurn,
                    },
                    recordResult,
                  )
                ) {
                  // 3b diagnostics: which guard fired? `rpc-limit_exceeded`
                  // means the server pool says done while our local tally
                  // (usedThisTurn vs preflight remaining) may still show room
                  // — that divergence is the metering-vs-display bug to chase
                  // server-side (docs/compass-limits.md).
                  const cause =
                    recordResult && !recordResult.ok && recordResult.error === "limit_exceeded"
                      ? "rpc-limit_exceeded"
                      : "local-tally";
                  logger.warn(
                    `[compass] stop cause=${cause} chat ${req.chatId}: usedThisTurn=${ctx.compassUsedThisTurn} ` +
                      `remaining=${ctx.compassRemainingBudget ?? "unknown"}`,
                  );
                  stopStreamForCompassLimit("onStepFinish");
                }
              },
              // Stall recovery: at abort time the SDK hands back every finished
              // step. This is the authoritative completed-step set — prefer it
              // over the incremental onStepFinish buffer if it carries more.
              onAbort: ({ steps }) => {
                const fromAbort = steps.flatMap(
                  (s) => (s.response?.messages ?? []) as ModelMessage[],
                );
                if (fromAbort.length > completedStepMessages.length) {
                  completedStepMessages.length = 0;
                  completedStepMessages.push(...fromAbort);
                }
              },
              onFinish: (response) => {
                const rt = reasoningTokensFromAiUsage(response.usage);
                if (typeof rt === "number") {
                  ctx.maxReasoningTokensUsed = Math.max(ctx.maxReasoningTokensUsed ?? 0, rt);
                }
                // v12 7D: accumulate input/output tokens for the BYOK cost line.
                const split = inputOutputTokensFromUsage(response.usage);
                if (split) {
                  ctx.turnInputTokens += split.inputTokens;
                  ctx.turnOutputTokens += split.outputTokens;
                }
                // v10.1 prompt caching: surface cache reads/writes per round.
                // v13.2: also accumulated for the cache-aware cost estimate.
                // v13.3 (ai@6): normalized inputTokenDetails carries read AND
                // write for every provider; anthropic metadata is the fallback.
                {
                  const u = response.usage as
                    | {
                        cachedInputTokens?: number;
                        inputTokenDetails?: {
                          cacheReadTokens?: number;
                          cacheWriteTokens?: number;
                        };
                      }
                    | undefined;
                  const cacheRead =
                    u?.inputTokenDetails?.cacheReadTokens ?? u?.cachedInputTokens;
                  const anthroMeta = response.providerMetadata?.anthropic as
                    | { cacheCreationInputTokens?: number | null }
                    | undefined;
                  const cacheWrite =
                    u?.inputTokenDetails?.cacheWriteTokens ??
                    anthroMeta?.cacheCreationInputTokens;
                  if (typeof cacheRead === "number" && cacheRead > 0) {
                    ctx.turnCachedInputTokens += cacheRead;
                  }
                  if (typeof cacheWrite === "number" && cacheWrite > 0) {
                    ctx.turnCacheCreationTokens += cacheWrite;
                  }
                  // OpenRouter reports the request's actual (cache-discounted)
                  // cost in credits ≈ USD.
                  const orUsage = (
                    response.providerMetadata?.openrouter as
                      | { usage?: { cost?: number | null } }
                      | undefined
                  )?.usage;
                  if (typeof orUsage?.cost === "number" && orUsage.cost > 0) {
                    ctx.turnActualCostUsd += orUsage.cost;
                  }
                  if (
                    (typeof cacheRead === "number" && cacheRead > 0) ||
                    (typeof cacheWrite === "number" && cacheWrite > 0)
                  ) {
                    logger.log(
                      `[prompt-cache] chat ${req.chatId}: read=${cacheRead ?? 0} write=${cacheWrite ?? 0} input=${(response.usage as { inputTokens?: number })?.inputTokens ?? "?"}`,
                    );
                  }
                }
                let totalTokens: number | null = totalTokensFromAiUsage(response.usage);
                if (totalTokens == null && response.usage && typeof response.usage === "object") {
                  const u = response.usage as Record<string, unknown>;
                  const p =
                    typeof u.promptTokens === "number"
                      ? u.promptTokens
                      : typeof u.inputTokens === "number"
                        ? u.inputTokens
                        : null;
                  const c =
                    typeof u.completionTokens === "number"
                      ? u.completionTokens
                      : typeof u.outputTokens === "number"
                        ? u.outputTokens
                        : null;
                  if (p != null || c != null) {
                    totalTokens = Math.round((p ?? 0) + (c ?? 0));
                  }
                }

                if (typeof totalTokens === "number" && totalTokens > 0) {
                  // We use the highest total tokens used (we are *not* accumulating)
                  // since we're trying to figure it out if we're near the context limit.
                  ctx.maxTokensUsed = Math.max(ctx.maxTokensUsed ?? 0, totalTokens);

                  // Core usage is recorded per step in onStepFinish (strict
                  // mid-task enforcement) — no aggregate record here.

                  logger.log(
                    `Total tokens used (aggregated for message ${placeholderAssistantMessage.id}): ${ctx.maxTokensUsed}`,
                  );

                  // v11.1: dead post-turn compaction scheduling deleted —
                  // compaction is model-triggered (compress_context) with
                  // automatic pre-dispatch/mid-loop gates + overflow retry.
                } else {
                  logger.log(
                    `Total tokens used (aggregated for message ${placeholderAssistantMessage.id}): unavailable (no total or prompt/completion counts from provider)`,
                  );
                }
              },
              onError: (error: any) => {
                if (isNoUsableModelOutputError(error)) {
                  logger.warn(
                    "[stream] onError: empty/no usable model output (handled by consumption/retry or auxiliary handlers)",
                    error,
                  );
                  return;
                }
                // FIX 4: network/transport failures are recoverable by the
                // outer retry wrapper. Don't surface the generic error box —
                // the wrapper will emit `chat:stream:reset-partial` and retry,
                // or eventually emit `chat:stream:disconnected`.
                if (isNetworkStreamError(error)) {
                  logger.warn(
                    "[stream] onError: network/transport failure (will retry silently)",
                    error,
                  );
                  return;
                }
                let errorMessage = (error as any)?.error?.message;
                const responseBody = error?.error?.responseBody;
                if (errorMessage && responseBody) {
                  errorMessage += "\n\nDetails: " + responseBody;
                }
                let message = errorMessage || JSON.stringify(error);
                if (modelClient.builtinProviderId === "compass") {
                  message = COMPASS_REACHABILITY_ERROR;
                } else {
                  message = modelFailureUserMessage(message);
                }
                const requestIdPrefix = isEngineEnabled
                  ? `[Request ID: ${engineRequestId}] `
                  : "";
                logger.error(
                  `AI stream text error for request: ${requestIdPrefix} errorMessage=${errorMessage} error=`,
                  error,
                );
                if (modelClient.builtinProviderId === "compass") {
                  sentryCaptureExceptionSafe(
                    new Error(`${requestIdPrefix}${message}`.slice(0, 500)),
                    {
                      tags: { feature: "compass", source: "main_stream" },
                      extra: { chatId: req.chatId },
                    },
                  );
                }
                // v12 2.3: was a raw event.sender.send — would throw on a
                // synthetic/destroyed sender (background agents). Wrapped.
                safeSend(event.sender, "chat:response:error", {
                  chatId: req.chatId,
                  streamId,
                  error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${requestIdPrefix}${message}`,
                });
                // Clean up the abort controller
                if (activeStreamId.get(req.chatId) === streamId) activeStreams.delete(req.chatId);
              },
              abortSignal: abortSignalOverride ?? abortController.signal,
            });
            // Best-effort: same-turn .catch on usage/finishReason/response. Node may still
            // print 1–2 "Unhandled rejection" lines around AI SDK flush ordering; main.ts
            // swallows empty-output rejections as a safety net.
            attachEmptyOutputSafeRejectHandlers(
              streamResult,
              logger.warn.bind(logger),
              "chat_stream",
            );
            return {
              fullStream: streamResult.fullStream,
              usage: streamResult.usage,
              finishReason: streamResult.finishReason,
              response: streamResult.response,
              /** Completed-step native messages captured for stall-resume.
               * Snapshot (not live) so a later read can't see post-abort mutation. */
              getResumeMessages: (): ModelMessage[] => completedStepMessages.slice(),
            };
}

export type SimpleStreamTextBundle = Awaited<ReturnType<typeof simpleStreamText>>;
