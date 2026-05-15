import { db } from "../../db";
import { apps, chats, chatContextSummaries } from "../../db/schema";
import { eq } from "drizzle-orm";
import {
  constructSystemPrompt,
} from "../../prompts/system_prompt";
import {
  SUPABASE_AVAILABLE_SYSTEM_PROMPT,
  SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT,
} from "../../prompts/supabase_prompt";
import log from "electron-log";
// extractCodebase removed - using diagram-first context system

import { TokenCountParams } from "../ipc_types";
import { TokenCountResult } from "../ipc_types";
import { estimateTokens, getContextWindow, getEffectiveBudget } from "../utils/token_utils";
import { createLoggedHandler } from "./safe_handle";
import { readSettings } from "@/main/settings";
import { extractMentionedAppsCodebases } from "../utils/mention_apps";
import { parseAppMentions } from "@/shared/parse_mention_apps";
import { isTurboEditsV2Enabled } from "@/lib/schemas";
import { getEphemeralChat, isEphemeralChatId } from "./chat_only_handlers";

const logger = log.scope("token_count_handlers");

const handle = createLoggedHandler(logger);

type TokenCountMessageRow = {
  id?: number;
  content: string;
  role: string;
  maxTokensUsed?: number | null;
  createdAt?: Date;
};

type AppRowForTokens = {
  id: number;
  supabaseProjectId: string | null;
  neonProjectId: string | null;
} | null;

// ═══════════════════════════════════════════════════════════════════
// PASS8 E1: System-prompt token estimate cache.
// ═══════════════════════════════════════════════════════════════════
// The system prompt only varies meaningfully per dispatch by chatMode +
// contextSize + turboEditsV2 + a date stamp + app version. The base
// (AGENTS_COMPACT + tool_contract + mode block + runtime identity) is
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
  contextSize: number;
  turboEditsV2: boolean;
  appSupabaseConfigured: boolean;
  appNeonConfigured: boolean;
}): SystemPromptCacheKey {
  return [
    args.chatMode,
    args.contextSize,
    args.turboEditsV2 ? "turbo" : "noturbo",
    args.appSupabaseConfigured ? "sup" : "nosup",
    args.appNeonConfigured ? "neon" : "noneon",
  ].join(":");
}

function getOrComputeSystemPromptTokens(args: {
  chatMode: "build" | "ask";
  contextSize: number;
  turboEditsV2: boolean;
  appSupabaseConfigured: boolean;
  appNeonConfigured: boolean;
}): number {
  const key = systemPromptCacheKey(args);
  const cached = SYSTEM_PROMPT_TOKEN_CACHE.get(key);
  const now = Date.now();
  if (cached && now - cached.builtAt < SYSTEM_PROMPT_CACHE_TTL_MS) {
    return cached.tokens;
  }
  let systemPrompt = constructSystemPrompt({
    chatMode: args.chatMode,
    contextSize: args.contextSize,
    enableTurboEditsV2: args.turboEditsV2,
  });
  if (args.appSupabaseConfigured) {
    systemPrompt += "\n\n" + SUPABASE_AVAILABLE_SYSTEM_PROMPT;
  } else if (!args.appNeonConfigured) {
    systemPrompt += "\n\n" + SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT;
  }
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

/** External hook so the stream handler can invalidate this cache after a write. */
export function invalidateMessageDeltaCache(chatId: number): void {
  MESSAGE_DELTA_CACHE.delete(chatId);
}

async function computeTokenCountResult(
  req: TokenCountParams,
  messages: TokenCountMessageRow[],
  app: AppRowForTokens,
): Promise<TokenCountResult> {
  const ordered = [...messages].sort((a, b) => {
    const ta = a.createdAt?.getTime() ?? 0;
    const tb = b.createdAt?.getTime() ?? 0;
    return ta - tb;
  });

  // PASS8 G1: Use chat_context_summaries when present so the UI reflects what
  // the stream path actually sends to the model after a DB-backed compaction.
  // Ephemeral / chat-only chats never carry summaries.
  let messageHistoryTokens: number;
  if (!isEphemeralChatId(req.chatId)) {
    const summaryRow = await db.query.chatContextSummaries.findFirst({
      where: eq(chatContextSummaries.chatId, req.chatId),
    });
    if (summaryRow) {
      const tail = ordered.filter(
        (m) => (m.id ?? 0) > summaryRow.lastMessageId,
      );
      const summaryTokens = estimateTokens(summaryRow.summaryText);
      const tailTokens = tail.reduce(
        (acc, m) => acc + estimateTokens(m.content),
        0,
      );
      messageHistoryTokens = summaryTokens + tailTokens;
      // FIX 4 / PASS8 G1 verification log: tells us, from a user's debug
      // dump, exactly which branch produced the figure shown in the UI.
      // Mirrors chat_stream_handlers.ts (summary + tail-only model dispatch).
      logger.log(
        `[token_count] summary+tail mode: summaryTokens=${summaryTokens} tailTokens=${tailTokens} total=${messageHistoryTokens} (chatId=${req.chatId}, tailMessages=${tail.length}, lastMessageId=${summaryRow.lastMessageId})`,
      );
    } else {
      messageHistoryTokens = computeDeltaTailTokens(req.chatId, ordered);
      // FIX 4: distinguish "G1 bypassed because no summary row" from the
      // ephemeral case below. A 252K reading on a non-ephemeral chat with
      // this log means compaction has not written a summary yet.
      logger.log(
        `[token_count] full-history mode (no summary row): tokens=${messageHistoryTokens} (chatId=${req.chatId}, messages=${ordered.length})`,
      );
    }
  } else {
    messageHistoryTokens = computeDeltaTailTokens(req.chatId, ordered);
    logger.log(
      `[token_count] full-history mode (ephemeral chat): tokens=${messageHistoryTokens} (chatId=${req.chatId}, messages=${ordered.length})`,
    );
  }

  const inputTokens = estimateTokens(req.input);

  const settings = readSettings();

  const mentionedAppNames = parseAppMentions(req.input);

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
  const systemPromptTokens = getOrComputeSystemPromptTokens({
    chatMode: cacheChatMode,
    contextSize,
    turboEditsV2: isTurboEditsV2Enabled(settings),
    appSupabaseConfigured: Boolean(app?.supabaseProjectId),
    appNeonConfigured: Boolean(app?.neonProjectId),
  });

  let codebaseTokens = 0;

  if (app) {
    // PASS8 I: DIAGRAM_CONTEXT_TOKENS is 0 — diagrams are model-driven only
    // (no auto-injection on workspace open). Stays at 0 here and in
    // proposal_handlers for parity.
    const DIAGRAM_CONTEXT_TOKENS = 0;
    codebaseTokens = DIAGRAM_CONTEXT_TOKENS;
  }

  const mentionedAppsCodebases = await extractMentionedAppsCodebases(
    mentionedAppNames,
    app?.id,
  );

  let mentionedAppsTokens = 0;
  if (mentionedAppsCodebases.length > 0) {
    const mentionedAppsContent = mentionedAppsCodebases
      .map(
        ({ appName, codebaseInfo }) =>
          `\n\n=== Referenced App: ${appName} ===\n${codebaseInfo}`,
      )
      .join("");

    mentionedAppsTokens = estimateTokens(mentionedAppsContent);

    // PASS8 F1: Estimated counts (~) only; not exact provider counts.
    logger.log(
      `Extracted ${mentionedAppsCodebases.length} mentioned app codebases, ~${mentionedAppsTokens} est. tokens`,
    );
  }

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
      if (isEphemeralChatId(req.chatId)) {
        const ephemeral = getEphemeralChat(req.chatId);
        if (!ephemeral) {
          throw new Error(`Chat not found: ${req.chatId}`);
        }
        let app: AppRowForTokens = null;
        if (ephemeral.appId != null) {
          app =
            (await db.query.apps.findFirst({
              where: eq(apps.id, ephemeral.appId),
            })) ?? null;
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
        return computeTokenCountResult(req, rows, app);
      }

      const chat = await db.query.chats.findFirst({
        where: eq(chats.id, req.chatId),
        with: {
          messages: {
            orderBy: (messages, { asc }) => [asc(messages.createdAt)],
          },
          app: true,
        },
      });

      if (!chat) {
        throw new Error(`Chat not found: ${req.chatId}`);
      }

      const rows: TokenCountMessageRow[] = chat.messages.map((m) => ({
        id: m.id,
        content: m.content,
        role: m.role,
        maxTokensUsed: m.maxTokensUsed,
        createdAt: m.createdAt,
      }));

      return computeTokenCountResult(req, rows, chat.app ?? null);
    },
  );
}
