import {
  constructSystemPrompt,
  type ModeSystemKey,
} from "../../prompts/system_prompt";
import { resolveEffectiveWorkMode } from "@/lib/work-mode";
import { measureToolSurface } from "@/lib/context/prompt-budget";
import log from "electron-log";
// extractCodebase removed - using diagram-first context system

import { TokenCountParams } from "../ipc_types";
import { TokenCountResult } from "../ipc_types";
import {
  estimateTokens,
  getContextWindow,
  getEffectiveBudget,
} from "../utils/token_utils";
import {
  bucketNativeTokensByTool,
  isNativeHistoryEnvelope,
  parseNativeHistory,
  type NativeToolTokenBuckets,
} from "@/lib/ai/native-history";
import { createLoggedHandler } from "./safe_handle";
import { readSettings } from "@/main/settings";
import {
  getStreamTransport,
  isStreamTransportId,
} from "@/lib/chat/stream-transport";
import { sliceFromLastCompactionSummary } from "@/lib/context/compaction";

const logger = log.scope("token_count_handlers");

const handle = createLoggedHandler(logger);

type TokenCountMessageRow = {
  id?: number;
  content: string;
  role: string;
  /**
   * The assistant row's native-history envelope, when it has one. This is what
   * the model ACTUALLY receives for that row (chat_stream_handlers expands it
   * into N ModelMessages and drops `content`), so counting `content` alone
   * undercounts by the entire tool history — every file body, grep hit, and
   * command output. Which, in a coding session, is most of the context.
   */
  modelContent?: string | null;
  /**
   * `session_messages.kind`. The slice below needs it to recognise a compaction
   * marker structurally — and to AGREE with the dispatch slice, which reads
   * `modelContent ?? content` for user rows while this path reads `content`. Two
   * consumers matching different fields is how they end up cutting the history in
   * two different places.
   */
  kind?: string | null;
  maxTokensUsed?: number | null;
  createdAt?: Date;
};

/** Per-row model-facing token estimate, split into meter buckets. */
type RowTokens = NativeToolTokenBuckets & { total: number };

const EMPTY_BUCKETS: NativeToolTokenBuckets = {
  filesRead: 0,
  searchResults: 0,
  otherToolOutput: 0,
  nonTool: 0,
};

/**
 * Score ONE history row the way the dispatch sees it: the native envelope when
 * present (per-tool attributed), otherwise the plain display string.
 */
function scoreRow(m: TokenCountMessageRow): RowTokens {
  const envelope = isNativeHistoryEnvelope(m.modelContent)
    ? parseNativeHistory(m.modelContent)
    : null;
  if (!envelope) {
    const total = estimateTokens(m.content);
    return { ...EMPTY_BUCKETS, nonTool: total, total };
  }
  const buckets = bucketNativeTokensByTool(envelope.messages);
  return {
    ...buckets,
    total:
      buckets.filesRead +
      buckets.searchResults +
      buckets.otherToolOutput +
      buckets.nonTool,
  };
}

function sumRows(rows: TokenCountMessageRow[]): RowTokens {
  return rows.reduce<RowTokens>(
    (acc, m) => {
      const t = scoreRow(m);
      return {
        filesRead: acc.filesRead + t.filesRead,
        searchResults: acc.searchResults + t.searchResults,
        otherToolOutput: acc.otherToolOutput + t.otherToolOutput,
        nonTool: acc.nonTool + t.nonTool,
        total: acc.total + t.total,
      };
    },
    { ...EMPTY_BUCKETS, total: 0 },
  );
}

// ═══════════════════════════════════════════════════════════════════
// PASS8 E1: System-prompt token estimate cache.
// ═══════════════════════════════════════════════════════════════════
// The system prompt only varies meaningfully per dispatch by chatMode +
// contextSize + a date stamp + app version. The base
// (AGENTS.md + tool_contract + mode block + runtime identity) is
// stable for the whole session. Recomputing the full estimate on every
// keystroke-driven count-tokens IPC call was responsible for ~5-15ms of
// repeated work per call.  Cache it.

type SystemPromptCacheKey = string;
type SystemPromptCacheEntry = {
  tokens: PromptPrefixTokens;
  builtAt: number;
};
const SYSTEM_PROMPT_TOKEN_CACHE = new Map<
  SystemPromptCacheKey,
  SystemPromptCacheEntry
>();
/** Cache TTL: the only dynamic content is a per-minute date stamp and the
 * app version (which never changes mid-session). Five minutes is plenty. */
const SYSTEM_PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * The whole fixed prefix: system prompt AND the tool surface.
 *
 * `effectiveWorkMode` is REQUIRED here. It used to be optional, and an
 * `undefined` sent `constructSystemPrompt` down its legacy all-five-modes path
 * — whose own dev warning says "never use for live streams" — so the meter
 * could report a prompt shape no dispatch has ever produced. There is no longer
 * a "legacy" key, because there is no longer a caller that omits the mode.
 */
type PromptPrefixTokens = {
  system: number;
  toolDescriptions: number;
  toolSchemas: number;
  total: number;
};

type PromptPrefixArgs = {
  chatMode: "build" | "ask";
  effectiveWorkMode: ModeSystemKey;
  contextSize: number;
  hasWorkspace: boolean;
  model: {
    name?: string;
    provider?: string;
    builtinProviderId?: string;
  };
};

function systemPromptCacheKey(args: PromptPrefixArgs): SystemPromptCacheKey {
  return [
    args.chatMode,
    args.effectiveWorkMode,
    args.contextSize,
    args.hasWorkspace ? "ws" : "no-ws",
    // The tool surface varies by model (the capability profile simplifies
    // schemas for weak ones), so a model switch must not read a stale entry.
    args.model.builtinProviderId ?? args.model.provider ?? "?",
    args.model.name ?? "?",
  ].join(":");
}

function getOrComputePromptPrefixTokens(
  args: PromptPrefixArgs,
): PromptPrefixTokens {
  const key = systemPromptCacheKey(args);
  const cached = SYSTEM_PROMPT_TOKEN_CACHE.get(key);
  const now = Date.now();
  if (cached && now - cached.builtAt < SYSTEM_PROMPT_CACHE_TTL_MS) {
    return cached.tokens;
  }
  const systemPrompt = constructSystemPrompt({
    chatMode: args.chatMode,
    effectiveWorkMode: args.effectiveWorkMode,
    contextSize: args.contextSize,
    hasWorkspace: args.hasWorkspace,
  });
  const system = estimateTokens(systemPrompt);

  // The half the meter never counted. Measured through the same resolver both
  // stream branches call, so this cannot drift from what dispatches.
  let toolDescriptions = 0;
  let toolSchemas = 0;
  try {
    const surface = measureToolSurface({
      workMode: args.effectiveWorkMode,
      hasWorkspace: args.hasWorkspace,
      workspaceIntegrationEligible: args.hasWorkspace,
      model: args.model,
    });
    toolDescriptions = surface.descriptionTokens;
    toolSchemas = surface.schemaTokens;
  } catch (e) {
    // A meter is not worth failing a keystroke over: report the system half and
    // say so, rather than throwing or silently pretending tools cost nothing.
    logger.warn(
      `[token_count] tool-surface measurement failed; reporting system prompt only: ${String(e)}`,
    );
  }

  const tokens: PromptPrefixTokens = {
    system,
    toolDescriptions,
    toolSchemas,
    total: system + toolDescriptions + toolSchemas,
  };
  SYSTEM_PROMPT_TOKEN_CACHE.set(key, { tokens, builtAt: now });
  return tokens;
}

// ═══════════════════════════════════════════════════════════════════
// PASS8 E2 + G1: Delta-tail message history estimate.
// ═══════════════════════════════════════════════════════════════════
// Two improvements over the previous "join all messages" path:
//
//  G1 — When chat_context_summaries has a row for this chat, parity with
//        the stream path is achieved by estimating
//          summaryText + messages where id > lastMessageId.
//        Otherwise the count-tokens UI stays stuck at 100% even after a
//        DB-backed compaction has shrunk what the model actually sees.
//
//  E2 — When no summary row exists, we still avoid rejoining everything by
//        caching a (chatId -> { lastMessageId, runningTokens }) pair and
//        only estimating messages with id strictly greater than that cached
//        id. The cache is invalidated whenever the latest message id moves
//        backward (e.g. message deletion / chat reset).

type MessageDeltaCacheEntry = {
  /**
   * Highest message id folded into `runningTokens` — always STRICTLY BELOW the
   * newest row (see below).
   */
  lastMessageId: number;
  /** Running per-bucket totals for messages up to and including lastMessageId. */
  runningTokens: RowTokens;
};
const MESSAGE_DELTA_CACHE = new Map<number, MessageDeltaCacheEntry>();

/**
 * The newest row is NEVER cached.
 *
 * An assistant row is pushed to the transport when the turn starts and mutated
 * as it goes: its `content` grows while streaming, and its `modelContent`
 * envelope — the entire tool history — is only stamped on at finalize
 * (turn-runner/finalize.ts). Caching by "highest id already seen" therefore
 * froze that row at whatever it looked like on the first mid-stream count, and
 * the post-stream `invalidateTokenCount()` refetch returned the same stale
 * number because the id had not moved. The history row only ever caught up when
 * the NEXT message arrived, which is exactly the "it doesn't update" symptom.
 *
 * Re-scoring one row per call is cheap; re-scoring the whole thread is what the
 * cache exists to avoid.
 */
function computeDeltaTailTokens(
  chatId: number,
  ordered: TokenCountMessageRow[],
): RowTokens {
  if (ordered.length === 0) {
    MESSAGE_DELTA_CACHE.delete(chatId);
    return { ...EMPTY_BUCKETS, total: 0 };
  }
  // Messages without ids (ephemeral / chat-only) fall back to full join — cheap, small.
  if (ordered.some((m) => m.id == null)) {
    return sumRows(ordered);
  }
  const sorted = [...ordered].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const newest = sorted[sorted.length - 1];
  const settled = sorted.slice(0, -1);
  const settledHighest = settled.length
    ? (settled[settled.length - 1].id ?? 0)
    : -1;

  const add = (a: RowTokens, b: RowTokens): RowTokens => ({
    filesRead: a.filesRead + b.filesRead,
    searchResults: a.searchResults + b.searchResults,
    otherToolOutput: a.otherToolOutput + b.otherToolOutput,
    nonTool: a.nonTool + b.nonTool,
    total: a.total + b.total,
  });

  const cached = MESSAGE_DELTA_CACHE.get(chatId);
  let settledTokens: RowTokens;
  if (!cached || cached.lastMessageId > settledHighest) {
    // Cold cache, or messages were removed (id moved backward) — recount fully.
    settledTokens = sumRows(settled);
  } else if (cached.lastMessageId === settledHighest) {
    settledTokens = cached.runningTokens;
  } else {
    // Warm cache — only score rows that settled since the last call.
    const newOnes = settled.filter((m) => (m.id ?? 0) > cached.lastMessageId);
    settledTokens = add(cached.runningTokens, sumRows(newOnes));
  }
  if (settled.length) {
    MESSAGE_DELTA_CACHE.set(chatId, {
      lastMessageId: settledHighest,
      runningTokens: settledTokens,
    });
  }
  return add(settledTokens, scoreRow(newest));
}

async function computeTokenCountResult(
  req: TokenCountParams,
  messages: TokenCountMessageRow[],
): Promise<TokenCountResult> {
  const ordered = [...messages].sort((a, b) => {
    const ta = a.createdAt?.getTime() ?? 0;
    const tb = b.createdAt?.getTime() ?? 0;
    return ta - tb;
  });

  // Mirror the live dispatch: when the history carries a persisted
  // [COMPACTION MARKER], the model only receives [marker .. latest] (see
  // sliceFromLastCompactionSummary at the chat_stream dispatch). Without this
  // the meter overstates the model's real context after a reopen — it would
  // count the full display history (~180K) instead of the sliced ~tail. The
  // delta cache keys on message id, so for the compacted case sum the small
  // slice directly rather than feeding it through the cache.
  const modelFacing = sliceFromLastCompactionSummary(ordered);
  const history =
    modelFacing.length === ordered.length
      ? computeDeltaTailTokens(req.chatId, ordered)
      : sumRows(modelFacing);
  const messageHistoryTokens = history.total;
  logger.log(
    `[token_count] workspace stream: tokens=${messageHistoryTokens} (chatId=${req.chatId}, messages=${ordered.length}, modelFacing=${modelFacing.length}, files=${history.filesRead}, search=${history.searchResults}, otherTools=${history.otherToolOutput})`,
  );

  const inputTokens = estimateTokens(req.input);

  const settings = readSettings();
  // This chat's own model (15.11.1), not the app-wide pick.
  const { turnModelForChat } = await import("@/lib/summarization_model");
  const chatModel = await turnModelForChat(req.chatId, settings);

  const contextSize = await getContextWindow(chatModel, req.chatId);

  // PASS8 E1: Cached system-prompt token estimate (recomputed at most every
  // SYSTEM_PROMPT_CACHE_TTL_MS, keyed by the params that actually influence it).
  // `selectedChatMode` is optional; the system-prompt builder only branches on
  // "build" vs "ask" (read-only modes like plan/debug/review estimate as Ask).
  // Default to "build" when undefined to match the dispatch default in
  // chat_stream_handlers.
  const rawChatMode = settings.selectedChatMode;
  const cacheChatMode: "ask" | "build" =
    rawChatMode === "ask"
      ? "ask"
      : rawChatMode === "build" ||
          rawChatMode === "agent" ||
          rawChatMode === undefined
        ? "build"
        : "ask";
  /**
   * The mode the next turn will ACTUALLY run in.
   *
   * This used to be hand-rolled here and got it wrong twice over: it resolved to
   * `undefined` whenever `intentMode` was "auto" or no global preference was
   * set (sending the prompt builder down its legacy all-five-modes path), and it
   * read the GLOBAL `workModePreference` even though sessions have owned their
   * own mode since v14.36.0 — so a session on Debug could be metered as Explore.
   *
   * Now it calls `resolveEffectiveWorkMode`, the same resolver
   * `chat_stream_handlers` dispatches with, and takes `req.workMode` in the
   * `workModeOverride` slot exactly as the stream takes the renderer's session
   * mode there. One rule, one place.
   */
  const tokenWorkMode = resolveEffectiveWorkMode({
    workModeOverride: req.workMode,
    intentMode: settings.intentMode,
    workModePreference: settings.workModePreference,
    selectedChatMode: settings.selectedChatMode ?? "ask",
  }) as ModeSystemKey;

  const prefix = getOrComputePromptPrefixTokens({
    chatMode: cacheChatMode,
    effectiveWorkMode: tokenWorkMode,
    contextSize,
    // A workspace-bound stream is the only path that reaches this handler
    // (the non-transport branch throws), so the workspace tools do bind.
    hasWorkspace: true,
    model: {
      name: settings.selectedModel?.name,
      provider: settings.selectedModel?.provider,
      // `builtinProviderId` is not on the persisted selection; the capability
      // profile falls back to provider + name, which is what it does for every
      // custom endpoint anyway.
      builtinProviderId: undefined,
    },
  });
  const systemPromptTokens = prefix.total;

  // The tool buckets are carved OUT of message history, never added on top:
  // tool results ARE history (they ride as native parts on the assistant rows),
  // so counting them separately would double the total.
  const totalTokens = messageHistoryTokens + inputTokens + systemPromptTokens;

  const lastAssistantMessage = [...ordered]
    .reverse()
    .find((m) => m.role === "assistant");
  const actualMaxTokens = lastAssistantMessage?.maxTokensUsed ?? null;

  const providerId = chatModel?.provider ?? "auto";
  const { budget: effectiveBudget, source: budgetSource } =
    await getEffectiveBudget(providerId, req.chatId);
  const contextWindow = await getContextWindow(chatModel, req.chatId);

  return {
    estimatedTotalTokens: totalTokens,
    actualMaxTokens,
    messageHistoryTokens,
    conversationTokens: history.nonTool,
    filesReadTokens: history.filesRead,
    searchResultTokens: history.searchResults,
    otherToolOutputTokens: history.otherToolOutput,
    inputTokens,
    systemPromptTokens,
    // The prefix, broken out. `systemPromptTokens` stays the whole fixed cost
    // (so existing consumers keep summing to the right total); these three
    // PARTITION it, the same contract the history buckets above follow.
    systemInstructionTokens: prefix.system,
    toolDescriptionTokens: prefix.toolDescriptions,
    toolSchemaTokens: prefix.toolSchemas,
    workMode: tokenWorkMode,
    contextWindow,
    effectiveBudget,
    providerId,
    budgetSource,
  };
}

export function registerTokenCountHandlers() {
  handle(
    "chat:count-tokens",
    async (_event, req: TokenCountParams): Promise<TokenCountResult> => {
      if (isStreamTransportId(req.chatId)) {
        const ephemeral = getStreamTransport(req.chatId);
        if (!ephemeral) {
          // The chat was torn down (session deleted / app teardown) between the
          // renderer's debounced request and now. Token count is a non-critical
          // estimate — return an empty result instead of throwing (was: Sentry
          // noise "Chat not found: -1" + a user-facing error toast).
          return computeTokenCountResult(req, []);
        }
        const rows: TokenCountMessageRow[] = (ephemeral.messages ?? []).map(
          (m) => ({
            id: typeof m.id === "number" ? m.id : undefined,
            content: typeof m.content === "string" ? m.content : "",
            role: m.role,
            // The assistant's native tool history. Without this the meter counts
            // the visible prose and misses every file body, grep hit and command
            // output the model is actually carrying.
            modelContent:
              "modelContent" in m && typeof m.modelContent === "string"
                ? (m as { modelContent: string }).modelContent
                : null,
            // Lets the slice below find a compaction marker by its column, and so
            // land on the same boundary the dispatch slice does.
            kind:
              "kind" in m && typeof m.kind === "string"
                ? (m as { kind: string }).kind
                : null,
            maxTokensUsed:
              "maxTokensUsed" in m && m.maxTokensUsed != null
                ? (m as { maxTokensUsed: number | null }).maxTokensUsed
                : null,
            createdAt:
              "createdAt" in m && m.createdAt instanceof Date
                ? m.createdAt
                : undefined,
          }),
        );
        return computeTokenCountResult(req, rows);
      }

      throw new Error(
        `Chat not found or legacy chat removed: ${req.chatId}. Open a workspace session.`,
      );
    },
  );
}
