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
import { streamText, isStepCount } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import type {
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
import {
  reasoningTokensFromAiUsage,
  totalTokensFromAiUsage,
} from "@/lib/usage/ai-usage";
import { classifyCompassFailure } from "@/lib/chat/compass-failure-classifier";
import { isInsufficientCreditError } from "@/lib/billing/insufficient-credit";
import { markCreditExhausted } from "@/lib/agents/credit-halt";
import { failQueuedDelegationsForChat } from "@/lib/agents/delegation-limiter";
import { cancelAllSubagentTasksForChat } from "@/lib/tools/spawn-task";
import {
  getNativeWebSearchSupport,
  reservedNativeToolNames,
} from "@/ipc/utils/native_web_search";
import {
  attachEmptyOutputSafeRejectHandlers,
  isNoUsableModelOutputError,
} from "@/ipc/utils/no_usable_model_output";
import { safeSend } from "@/ipc/utils/safe_sender";
import { bucketNativeTokensByTool } from "@/lib/ai/native-history";
import {
  getExtraProviderOptions,
  getReasoningEffort,
} from "@/ipc/utils/thinking_utils";
import {
  getMaxTokensWithFloor,
  getTemperature,
} from "@/ipc/utils/token_utils";
import {
  isNetworkStreamError,
  isForcedToolChoiceRejection,
} from "@/ipc/handlers/chat_stream/network-retry";
import {
  currentPlanLedger,
  takeRefreshedPlanLedger,
} from "@/lib/tasks/plan-ledger-refresh";
import {
  isImageContentRejectionError,
  imageUnsupportedUserMessage,
  isPdfContentRejectionError,
  pdfUnsupportedUserMessage,
} from "@/lib/chat/image-embed-gate";
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
import { takePendingDroppedHistoryNotice } from "@/lib/context/dropped-history-notice";
import { takePendingSubagentResults } from "@/lib/agents/subagent-results";
import { takePendingUserInterjections } from "@/lib/agent/user-interjections";
import { deliverInterjectionsToTranscript } from "@/ipc/handlers/chat_stream/interjection-delivery";
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
  resolveDispatchCapabilityProviderId,
  deriveReasoningCeiling,
  shouldOmitTemperature,
} from "@/lib/routing/reasoning-detector";
import { systemReminder } from "@/lib/streaming/system-reminder";
import { buildStepMessages } from "@/lib/streaming/step-messages";
import {
  AI_STREAMING_ERROR_MESSAGE_PREFIX,
  modelFailureUserMessage,
} from "@/shared/texts";
import type { StreamTurnContext } from "@/ipc/handlers/chat_stream/turn-context";

const logger = log.scope("chat_stream_handlers");

/**
 * The `providerOptions` key an OpenAI-compatible client reads.
 *
 * The SDK accepts its own provider name AND the camelCase form of it, but treats the
 * raw form as DEPRECATED whenever the two differ — which they do for any id carrying
 * a hyphen. Our own provider ids (`compass`, `deepseek`, `qwen`, `minimax`) are all
 * single words and unaffected, but a user's custom provider is commonly named
 * `my-proxy`, and that is exactly the case that would start warning and, if the
 * deprecation is ever enforced, stop being read at all.
 */
function providerOptionsBucketName(providerId: string): string {
  const camel = providerId.replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase());
  return camel === providerId ? providerId : camel;
}

export interface SimpleStreamTextArgs {
  chatMessages: ModelMessage[];
  modelClient: ModelClient;
  tools?: ToolSet;
  systemPromptOverride?: string;
  /** PASS8 A5: prepended as a system-role message so the static `system`
   * field stays cache-eligible across turns. */
  dynamicSystemTail?: string;
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
  effectiveAppId: number | undefined;
  effectiveModel: LargeLanguageModel;
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
    repetition,
    abortSignalOverride,
    maxStepsPerRound,
  }: SimpleStreamTextArgs,
) {
  const {
    req,
    settings,
    effectiveAppId,
    effectiveModel,
    enableNativeReasoning,
    proactiveContextReminderForStream,
    modeReanchorNote,
    taskLedgerBlock,
    budgetTracker,
    streamId,
    event,
    placeholderAssistantMessage,
    preflight,
    ttftStartRef,
    abortController,
  } = deps;
            // Sticky fallback: once a provider has refused the forced tool_choice
            // this turn, deliver pending results through the prepareStep injection
            // instead. Shadows the deps value so the tool registration below and
            // every drain guard in prepareStep agree on ONE decision — they must,
            // or collect_results is forced while the results have already been
            // drained (or vice versa, leaving them undelivered).
            const forceCollectOnWake =
              deps.forceCollectOnWake && !ctx.forcedToolChoiceRejected;
            logger.log("sending AI request");
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
            // Per-provider buckets only. Two inherited keys used to open this
            // object, addressed to the removed hosted engine and its upstream
            // gateway; no provider declared either identifier, so nothing read
            // them. Reasoning options now go in the real per-provider buckets
            // below (openrouter / google|vertex / openai|azure).
            const providerOptions: Record<string, any> = {};

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
              // Capability keys off the VENDOR serving the request; the buckets below
              // key off the WIRE provider. For Atlarix Core those differ (`compass` on
              // the wire, whatever core-models.json routes to underneath).
              const capabilityProviderId = resolveDispatchCapabilityProviderId(
                effectiveModel,
                modelClient.builtinProviderId,
              );
              // Wire provider: this classifies which native request SHAPE the route
              // accepts, not who serves the model.
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
              if (reasoningPatch.anthropic) {
                // Direct Anthropic extended thinking. Merged rather than assigned:
                // the cache-marker work below also writes providerOptions.anthropic.
                providerOptions.anthropic = {
                  ...providerOptions.anthropic,
                  ...reasoningPatch.anthropic,
                };
              }

              // OpenAI-COMPATIBLE clients — Atlarix Core (`compass`) and every
              // open-weight BYOK provider (deepseek / qwen / minimax / …), all built
              // by `createOpenAICompatible({ name: <provider id> })`.
              //
              // These have no bucket above, and this is the link that was missing:
              // `resolveReasoningRequest` has always resolved the right per-model
              // control (effort / toggle / budget / none, from what the model itself
              // declares) but its output was only ever read as a boolean "can this
              // model reason", never placed in a request. So the Deep-thinking toggle
              // moved nothing on the wire for any of these providers.
              //
              // The bucket name must be the WIRE provider — the SDK reads
              // `providerOptions[<its own name>]` — while the capability lookup uses
              // the vendor. `reasoningEffort` is translated to `reasoning_effort` by
              // the SDK; `thinking` passes through into the body untouched.
              //
              // Skipped when a native patch above already claimed this route: those
              // SDKs take reasoning in their OWN shape, and adding a second,
              // differently-shaped instruction to the same bucket can only contradict
              // the first (OpenRouter's `reasoning` object beside a bare
              // `reasoning_effort`, a `thinking` block inside Google's options).
              const handledNatively =
                Boolean(reasoningPatch.openrouter) ||
                Boolean(reasoningPatch.google) ||
                Boolean(reasoningPatch.openai) ||
                Boolean(reasoningPatch.anthropic);
              if (modelClient.builtinProviderId && !handledNatively) {
                const compatibleReasoning = getExtraProviderOptions(
                  capabilityProviderId,
                  settings,
                  true,
                  maxOutputTokens,
                  catalogModelId,
                );
                if (Object.keys(compatibleReasoning).length > 0) {
                  const bucket = providerOptionsBucketName(
                    modelClient.builtinProviderId,
                  );
                  providerOptions[bucket] = {
                    ...providerOptions[bucket],
                    ...compatibleReasoning,
                  };
                }
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
            // Anthropic rejects temperature != 1 while extended thinking is on,
            // and getTemperature defaults to 0 — see shouldOmitTemperature.
            const temperature = shouldOmitTemperature(providerOptions)
              ? undefined
              : await preflight.time("temperature", () =>
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
            /** Running per-tool token attribution for THIS turn's live meter. */
            const turnBuckets = {
              filesRead: 0,
              searchResults: 0,
              otherToolOutput: 0,
            };
            const streamResult = streamText({
              // ai@7 REJECTS `role: "system"` inside `messages` by default —
              // "Invalid prompt: System messages are not allowed…" — which failed
              // 65 evals on the v6→v7 bump. That layout is deliberate, not
              // incidental: `buildStreamMessagesWithCacheBreakpoints` places the
              // system header and the per-turn tail as MESSAGES precisely so the
              // header keeps a stable prefix and the tail stops invalidating the
              // provider prompt cache every turn (v10.1), with Anthropic
              // cache-control riding on those parts.
              //
              // Re-permitting it keeps that layout byte-for-byte, which is what
              // makes this safe to verify: `[prompt-cache] read=` must be
              // unchanged. Moving the header into v7's `instructions` (which does
              // accept `Array<SystemModelMessage>`, so breakpoints could survive)
              // is the aligned end state, but it is a prompt-cache change and
              // belongs in its own commit with its own measurement — not smuggled
              // into an SDK bump.
              allowSystemInMessages: true,
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
              // The optional step cap (interactive build only) bounds an
              // in-round runaway so it returns to the round boundary instead of
              // spinning unbounded — undefined leaves headless/ask uncapped.
              stopWhen:
                typeof maxStepsPerRound === "number" && maxStepsPerRound > 0
                  ? [isStepCount(maxStepsPerRound)]
                  : [() => false],
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
                // History was trimmed under the model this dispatch. Telling it is
                // the whole point: silent loss is what makes a model confabulate
                // over the gap instead of re-reading.
                const droppedHistory = takePendingDroppedHistoryNotice(req.chatId);
                // #15: re-anchor the active mode at the START of the turn (step 0)
                // so it's the last thing before the model acts. Ephemeral /
                // step-input-only like the other nudges — never persisted.
                // #A1/#A4: the compact task ledger rides the same step-0 recency
                // slot (just before the mode re-anchor) — carries the active goal
                // (in-progress step) so mode+goal are both freshly re-asserted.
                const modeReanchor = stepNumber === 0 ? modeReanchorNote : null;
                // Step 0 carries the turn-start snapshot ONLY on the turn's
                // first round. run-agent-turn re-enters the stream per agentic
                // round (gate nudge, stall resume, continuation), and each round
                // restarts `stepNumber` at 0 — so serving `taskLedgerBlock`
                // unconditionally here re-asserted turn-start counts after the
                // model had already marked steps done, which reads to it as the
                // plan having been reset. currentPlanLedger returns null until
                // the plan is actually mutated, so round 1 is unchanged.
                //
                // On LATER steps within a round a refreshed block appears only
                // when the plan changed (take-once), so an unchanged ledger is
                // not restated every step.
                const taskLedger =
                  stepNumber === 0
                    ? (currentPlanLedger(req.chatId) ?? taskLedgerBlock)
                    : takeRefreshedPlanLedger(req.chatId);
                // #12: targeted empty-output nudge (take-once), set by the retry.
                const emptyOutputNudge = ctx.pendingEmptyOutputNudge;
                ctx.pendingEmptyOutputNudge = null;
                /**
                 * MID-TURN USER MESSAGES. The owner's ask: "not cancel just come
                 * in as my message" — a message typed while the turn runs reaches
                 * the running turn instead of being held and replayed as a new
                 * one.
                 *
                 * NOT GATED ON `forceCollectOnWake`, unlike every drain above it.
                 * That guard exists because `collect_results` is the single
                 * consumer of BACKGROUND results, and draining them here too
                 * would either double-deliver or leave the forced tool empty. A
                 * user interjection is a different payload on a different channel
                 * with no tool consumer, so routing it through a tool result
                 * would be a category error — and suppressing it on a wake turn
                 * would silently swallow the user's own words.
                 */
                const interjections = takePendingUserInterjections(req.chatId);
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
                if (interjections?.length) {
                  logger.log(
                    `[interjection] delivering ${interjections.length} mid-turn user message(s) (chat ${req.chatId}, step ${stepNumber})`,
                  );
                }
                const injected = [
                  reminder,
                  droppedHistory,
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
                  // The harness half of a mid-turn message: the user's own words
                  // go below, UNTAGGED, and this says how to read them. Kept in
                  // the tagged block on purpose — guidance about the message is
                  // the harness talking, and putting it in the user's mouth is
                  // exactly the confusion the tag convention exists to prevent.
                  interjections?.length
                    ? `The user sent ${interjections.length === 1 ? "a message" : `${interjections.length} messages`} while you were working; ${interjections.length === 1 ? "it appears" : "they appear"} below as ${interjections.length === 1 ? "a real user turn" : "real user turns, oldest first"}. Fold ${interjections.length === 1 ? "it" : "them"} into what you are already doing and continue — do NOT restart, re-greet, or re-answer earlier requests. If ${interjections.length === 1 ? "it changes" : "they change"} the goal, say so briefly and change course.`
                    : null,
                ]
                  .filter(Boolean)
                  .join("\n\n");
                // v14.8.8: frame the whole harness-injected block as out-of-band
                // so a recency-biased model never reads these nudges as a fresh
                // user request (only genuine user turns stay untagged).
                //
                // WHICH IS PRECISELY WHY THE INTERJECTIONS ARE NOT WRAPPED.
                // `system-reminder.ts` states the convention: harness content is
                // `role:"user"` because providers reject mid-conversation
                // `role:"system"`, and the TAG is what marks it as not-real-input
                // — "only untagged user turns are real user input". A mid-turn
                // message from the user IS real user input, so untagged is not a
                // shortcut here, it is the correct channel. These are the first
                // untagged injections on this seam.
                //
                // Each one is its OWN message, oldest first, so a correction that
                // followed a request still reads in the order it was typed.
                // (Consecutive untagged user messages already occur today — the
                // tagged block below is appended after `messages` that may itself
                // end with a user turn — so this is not a new provider shape.)
                const assembled = buildStepMessages({
                  messages,
                  injected,
                  interjections,
                  tag: systemReminder,
                });
                const stepMessages = assembled.messages as typeof messages;
                if (interjections?.length) {
                  // Transcript + durable persistence. Fire-and-forget: the words
                  // are already in `stepMessages`, so a slow session write must
                  // never delay the dispatch.
                  void deliverInterjectionsToTranscript({
                    chatId: req.chatId,
                    streamId,
                    event,
                    placeholderMessageId: Number(placeholderAssistantMessage?.id),
                    interjections,
                  });
                }
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
                // `assembled.changed` rather than `injected`: an
                // interjection-only step changes the messages with an empty
                // `injected`, and returning `undefined` there would drop the
                // user's message on the floor.
                const changedMessages = assembled.changed;
                const base =
                  cacheMarkerPlacement !== "none" &&
                  (stepNumber > 0 || changedMessages)
                    ? {
                        messages: advanceCacheBreakpointsForStep(
                          stepMessages,
                          cacheMarkerPlacement,
                        ),
                      }
                    : changedMessages
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
              // ai@7 renamed these; the old names still work but are deprecated,
              // and the callback TYPES are identical aliases, so this is a rename
              // and nothing else.
              onStepEnd: async (step) => {
                // Capture this step's native messages for stall-resume BEFORE any
                // provider-specific early return below.
                recordStepMessages(
                  step.response?.messages as
                    | readonly ModelMessage[]
                    | undefined,
                );
                // Live token meter — emit the provider's REAL usage every step,
                // for EVERY provider (not just compass), so the composer meter
                // reflects true context occupancy as the turn progresses. The
                // latest step's input already includes full history + prior
                // tool results, so input+output ≈ current occupancy.
                try {
                  // Per-tool attribution for the context-meter breakdown.
                  //
                  // Mid-turn this is the ONLY place the buckets can come from:
                  // tool results live in the turn's native messages and are not
                  // serialized onto the assistant row's `modelContent` until
                  // finalize, so the count-tokens IPC literally cannot see them
                  // while the turn is running — re-querying it would return the
                  // same frozen numbers every tick. Accumulated across steps and
                  // sent as a running total, so a dropped emit self-heals on the
                  // next step instead of losing a delta forever.
                  const stepMessages = step.response?.messages as
                    | ModelMessage[]
                    | undefined;
                  if (stepMessages?.length) {
                    const b = bucketNativeTokensByTool(stepMessages);
                    turnBuckets.filesRead += b.filesRead;
                    turnBuckets.searchResults += b.searchResults;
                    turnBuckets.otherToolOutput += b.otherToolOutput;
                  }
                } catch {
                  /* attribution is cosmetic — never break the stream */
                }
                try {
                  const split = inputOutputTokensFromUsage(step.usage);
                  const total = totalTokensFromAiUsage(step.usage);
                  if (split || total != null) {
                    safeSend(event.sender, "chat:token-usage", {
                      chatId: req.chatId,
                      inputTokens: split?.inputTokens ?? null,
                      outputTokens: split?.outputTokens ?? 0,
                      totalTokens:
                        total ??
                        (split?.inputTokens ?? 0) + (split?.outputTokens ?? 0),
                      // The cache split, which `inputOutputTokensFromUsage`
                      // already resolves and this emit used to discard. Without
                      // it a consumer sees only the gross input count and has no
                      // way to price it: a cached read costs a small fraction of
                      // a fresh one — on DeepSeek roughly a thirtieth — so a
                      // trajectory reporting gross input alone overstates spend
                      // by more than an order of magnitude on a long agent run,
                      // which is exactly the sort of run this is used for.
                      ...(split?.cachedInputTokens != null
                        ? { cachedInputTokens: split.cachedInputTokens }
                        : {}),
                      ...(split?.cacheCreationInputTokens != null
                        ? { cacheCreationInputTokens: split.cacheCreationInputTokens }
                        : {}),
                      toolBuckets: { ...turnBuckets },
                    });
                  }
                } catch {
                  /* best-effort live meter — never break the stream */
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
              onEnd: (response) => {
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
                // The provider refused our forced tool_choice. The round wrapper
                // retries once without it, so this must not paint an error box the
                // user then watches get contradicted by a successful answer.
                if (isForcedToolChoiceRejection(error)) {
                  logger.warn(
                    "[stream] onError: provider rejected the forced tool_choice (retrying without it)",
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
                // Only Core INFRA errors (reachability / core_unavailable) warrant a
                // Sentry event; a user running out of credit (402) is expected state.
                let isCompassInfraError = false;
                if (isPdfContentRejectionError(error)) {
                  // Checked BEFORE the image matcher: a turn can carry both, and
                  // the image matcher's broader "unsupported" clauses would
                  // otherwise claim a document rejection and send the user off
                  // hunting for a vision model.
                  message = pdfUnsupportedUserMessage();
                } else if (isImageContentRejectionError(error)) {
                  // The model's API rejected the embedded image (text-only chat
                  // API, e.g. DeepSeek's "unknown variant image_url"). Replace the
                  // raw JSON deserialize error with a clear, actionable message
                  // instead of the scary provider dump.
                  message = imageUnsupportedUserMessage();
                } else if (modelClient.builtinProviderId === "compass") {
                  const statusCode =
                    (error as any)?.statusCode ?? (error as any)?.error?.statusCode;
                  const rawBody =
                    (error as any)?.responseBody ?? (error as any)?.error?.responseBody ?? "";
                  const bodyStr =
                    typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody ?? "");
                  // Every Core failure gets its status + body logged BEFORE
                  // classification. Previously only 402/503 were recognised and
                  // everything else collapsed to "trouble reaching Core", so a
                  // precise upstream error (the DeepSeek tool_choice rejection that
                  // killed background-resume turns) was unreadable from the outside.
                  logger.error(
                    `[compass] upstream failure status=${statusCode ?? "none"} body=${bodyStr.slice(0, 800)}`,
                  );
                  // Ordering lives in the classifier, where it is tested — a ban
                  // arrives as 403 and MUST NOT be reported as an expired session.
                  const classified = classifyCompassFailure(statusCode, bodyStr);
                  message = classified.message;
                  isCompassInfraError = classified.isCompassInfraError;
                  /**
                   * The PARENT ran out of credit — so its children must stop too.
                   *
                   * This handler used to send the error and drop the abort controller
                   * without cancelling a single sub-agent, so a refused parent left
                   * its whole fan-out streaming: five children still spending against
                   * a wallet that had just declined the parent. Credit exhaustion is
                   * the fourth thing that ends a round, after user Stop, user Abort
                   * and the automation timeout.
                   *
                   * The turn's `abortController` is deliberately NOT aborted here.
                   * Children hold their own abort handles (`taskAbort` in spawn-task),
                   * which is why cancelling them takes the task store rather than this
                   * signal — and the model call has already failed, so there is no
                   * in-flight work of our own left for an abort to reach. Firing it
                   * would only push this failure through the user-cancel teardown,
                   * whose revert semantics are guarded by their own tests, for no
                   * behaviour we need.
                   */
                  if (isInsufficientCreditError(error)) {
                    markCreditExhausted(req.chatId, message);
                    const queued = failQueuedDelegationsForChat(
                      req.chatId,
                      new Error(message),
                    );
                    const running = cancelAllSubagentTasksForChat(
                      req.chatId,
                      message,
                    );
                    if (running > 0 || queued > 0) {
                      logger.warn(
                        `[compass] credit exhausted on the parent — stopped ${running} running and ${queued} queued sub-agent(s) for chat ${req.chatId}`,
                      );
                    }
                  }
                } else {
                  message = modelFailureUserMessage(message);
                }
                logger.error(
                  `AI stream text error for request: errorMessage=${errorMessage} error=`,
                  error,
                );
                if (modelClient.builtinProviderId === "compass" && isCompassInfraError) {
                  sentryCaptureExceptionSafe(
                    new Error(message.slice(0, 500)),
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
                  error: `${AI_STREAMING_ERROR_MESSAGE_PREFIX}${message}`,
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
              // `fullStream` is the deprecated spelling of `stream` in ai@7 (same
              // type). Our own bundle key stays `fullStream` so consumers are
              // untouched — only the SDK-side read moves.
              fullStream: streamResult.stream,
              usage: streamResult.usage,
              finishReason: streamResult.finishReason,
              response: streamResult.response,
              /**
               * ai@7: the ACCUMULATED assistant/tool messages for the whole call.
               *
               * `response.messages` used to carry these. In v7 the top-level
               * `response` is deprecated and resolves to `finalStep.response`, so
               * it holds only the LAST step's messages — which silently dropped
               * turn-1's native tool exchange whenever the final step was plain
               * text, and broke native-history folding (B1/B2) across turns.
               */
              responseMessages: streamResult.responseMessages,
              /** Completed-step native messages captured for stall-resume.
               * Snapshot (not live) so a later read can't see post-abort mutation. */
              getResumeMessages: (): ModelMessage[] => completedStepMessages.slice(),
            };
}

export type SimpleStreamTextBundle = Awaited<ReturnType<typeof simpleStreamText>>;
