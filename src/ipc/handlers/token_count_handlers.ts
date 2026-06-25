import {
  constructSystemPrompt,
  type ModeSystemKey,
} from "../../prompts/system_prompt";
import type { WorkMode } from "@/lib/schemas";
import log from "electron-log";
// extractCodebase removed - using diagram-first context system

import { TokenCountParams } from "../ipc_types";
import { TokenCountResult } from "../ipc_types";
import { estimateTokens, getContextWindow, getEffectiveBudget } from "../utils/token_utils";
import { createLoggedHandler } from "./safe_handle";
import { readSettings } from "@/main/settings";
import { isTurboEditsV2Enabled } from "@/lib/schemas";
import { getStreamTransport, isStreamTransportId } from "@/lib/chat/stream-transport";

const logger = log.scope("token_count_handlers");

const handle = createLoggedHandler(logger);

type TokenCountMessageRow = {
  id?: number;
  content: string;
  role: string;
  maxTokensUsed?: number | null;
  createdAt?: Date;
};

// ═══════════════════════════════════════════════════════════════════
// PASS8 E1: System-prompt token estimate cache.
// ═══════════════════════════════════════════════════════════════════
// The system prompt only varies meaningfully per dispatch by chatMode +
// contextSize + turboEditsV2 + a date stamp + app version. The base
// (AGENTS.md + tool_contract + mode block + runtime identity) is
// stable for the whole session. Recomputing the full estimate on every
// keystroke-driven count-tokens IPC call was responsible for ~5-15ms of
// repeated work per call.  Cache it.

type SystemPromptCacheKey = string;
type SystemPromptCacheEntry = {
  tokens: number;
  builtAt: number;
};
const SYSTEM_PROMPT_TOKEN_CACHE = new Map<
  SystemPromptCacheKey,
  SystemPromptCacheEntry
>();
/** Cache TTL: the only dynamic content is a per-minute date stamp and the
 * app version (which never changes mid-session). Five minutes is plenty. */
const SYSTEM_PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

function systemPromptCacheKey(args: {
  chatMode: "build" | "ask";
  effectiveWorkMode?: ModeSystemKey;
  contextSize: number;
  turboEditsV2: boolean;
}): SystemPromptCacheKey {
  return [
    args.chatMode,
    args.effectiveWorkMode ?? "legacy",
    args.contextSize,
    args.turboEditsV2 ? "turbo" : "noturbo",
  ].join(":");
}

function getOrComputeSystemPromptTokens(args: {
  chatMode: "build" | "ask";
  effectiveWorkMode?: ModeSystemKey;
  contextSize: number;
  turboEditsV2: boolean;
}): number {
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
    enableTurboEditsV2: args.turboEditsV2,
    hasWorkspace: true,
  });
  const tokens = estimateTokens(systemPrompt);
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
  /** Highest message id we have already counted. */
  lastMessageId: number;
  /** Running running-total token estimate for messages up to and including lastMessageId. */
  runningTokens: number;
};
const MESSAGE_DELTA_CACHE = new Map<number, MessageDeltaCacheEntry>();

function computeDeltaTailTokens(
  chatId: number,
  ordered: TokenCountMessageRow[],
): number {
  if (ordered.length === 0) {
    MESSAGE_DELTA_CACHE.delete(chatId);
    return 0;
  }
  // Messages without ids (ephemeral / chat-only) fall back to full join — cheap, small.
  if (ordered.some((m) => m.id == null)) {
    return ordered.reduce((acc, m) => acc + estimateTokens(m.content), 0);
  }
  const sorted = [...ordered].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const highest = sorted[sorted.length - 1].id ?? 0;
  const cached = MESSAGE_DELTA_CACHE.get(chatId);
  if (!cached || cached.lastMessageId > highest) {
    // Cold cache, or messages were removed (id moved backward) — recount fully.
    const total = sorted.reduce((acc, m) => acc + estimateTokens(m.content), 0);
    MESSAGE_DELTA_CACHE.set(chatId, { lastMessageId: highest, runningTokens: total });
    return total;
  }
  if (cached.lastMessageId === highest) {
    return cached.runningTokens;
  }
  // Warm cache — only score newly-arrived messages.
  const newOnes = sorted.filter((m) => (m.id ?? 0) > cached.lastMessageId);
  const delta = newOnes.reduce((acc, m) => acc + estimateTokens(m.content), 0);
  const next = { lastMessageId: highest, runningTokens: cached.runningTokens + delta };
  MESSAGE_DELTA_CACHE.set(chatId, next);
  return next.runningTokens;
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

  const messageHistoryTokens = computeDeltaTailTokens(req.chatId, ordered);
  logger.log(
    `[token_count] workspace stream: tokens=${messageHistoryTokens} (chatId=${req.chatId}, messages=${ordered.length})`,
  );

  const inputTokens = estimateTokens(req.input);

  const settings = readSettings();

  const contextSize = await getContextWindow(settings.selectedModel, req.chatId);

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
      : rawChatMode === "build" || rawChatMode === "agent" || rawChatMode === undefined
        ? "build"
        : "ask";
  const pref = settings.workModePreference as WorkMode | undefined;
  const tokenWorkMode: ModeSystemKey | undefined =
    (settings.intentMode ?? cacheChatMode) !== "auto" && pref
      ? pref
      : undefined;
  const systemPromptTokens = getOrComputeSystemPromptTokens({
    chatMode: cacheChatMode,
    effectiveWorkMode: tokenWorkMode,
    contextSize,
    turboEditsV2: isTurboEditsV2Enabled(settings),
  });

  // PASS8 I: codebase tokens stay 0 — diagrams are model-driven only
  // (no auto-injection on workspace open).
  const codebaseTokens = 0;

  // @-mention (file/folder) context is injected at dispatch; we don't read those
  // files on every keystroke for the live estimate. Its real cost shows up in the
  // [budget]/[TTFT] logs and is handled by compaction.
  const mentionedAppsTokens = 0;

  const totalTokens =
    messageHistoryTokens +
    inputTokens +
    systemPromptTokens +
    codebaseTokens +
    mentionedAppsTokens;

  const lastAssistantMessage = [...ordered]
    .reverse()
    .find((m) => m.role === "assistant");
  const actualMaxTokens = lastAssistantMessage?.maxTokensUsed ?? null;

  const providerId = settings.selectedModel?.provider ?? "auto";
  const { budget: effectiveBudget, source: budgetSource } = await getEffectiveBudget(providerId, req.chatId);
  const contextWindow = await getContextWindow(settings.selectedModel, req.chatId);

  return {
    estimatedTotalTokens: totalTokens,
    actualMaxTokens,
    messageHistoryTokens,
    codebaseTokens,
    mentionedAppsTokens,
    inputTokens,
    systemPromptTokens,
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
        const rows: TokenCountMessageRow[] = (ephemeral.messages ?? []).map((m) => ({
          content: typeof m.content === "string" ? m.content : "",
          role: m.role,
          maxTokensUsed:
            "maxTokensUsed" in m && m.maxTokensUsed != null
              ? (m as { maxTokensUsed: number | null }).maxTokensUsed
              : null,
          createdAt:
            "createdAt" in m && m.createdAt instanceof Date
              ? m.createdAt
              : undefined,
        }));
        return computeTokenCountResult(req, rows);
      }

      throw new Error(
        `Chat not found or legacy chat removed: ${req.chatId}. Open a workspace session.`,
      );
    },
  );
}
