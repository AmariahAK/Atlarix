/**
 * Context Compaction - Phase 6
 * When context bar fills, AI summarizes the session for continuity.
 * Claude Code / OpenCode style.
 */

import { generateText } from "ai";
import { db } from "../db";
import { chatContextSummaries, messages } from "../db/schema";
import { eq } from "drizzle-orm";
import { readSettings } from "../main/settings";
import { getModelClient } from "../ipc/utils/get_model_client";
import { getCompactionSummarizationModel } from "./summarization_model";
import { estimateTokens, getEffectiveBudget } from "../ipc/utils/token_utils";
import {
  CONTEXT_COMPACTION_SYSTEM,
  buildCompactionUserPromptPrefix,
} from "../prompts/context_compaction_prompt";
import log from "electron-log";
import { getLedger, getLedgerStateString } from "./tasks/task-ledger";
import { getCachedOpenRouterModelRow } from "./routing/tier-context-limits";

const logger = log.scope("context-compaction");

/** Threshold: run compaction when usage exceeds this % of usable context (after output reserve). */
const COMPACTION_THRESHOLD = 0.75;

/** Match OpenRouter tier safety: effective context = raw × this factor. */
const MODEL_CONTEXT_SAFETY = 0.8;

const DEFAULT_MODEL_CONTEXT_FALLBACK = 128_000;

/**
 * Tool-output token budget kept verbatim at the tail of the transcript before compaction summarization.
 * Stream-time pruning (`pruneToolOutputsInMessages`) uses separate limits.
 */
export const HEAD_TOOL_TOKENS = 40_000;

/** Reserve tokens for model output when estimating */
const OUTPUT_RESERVE_RATIO = 0.2;

interface MessageForCompaction {
  id: number;
  role: string;
  content: string;
}

/** Absolute token trigger for post-turn compaction from a model context length (tokens). */
export function getCompactionThresholds(contextLength: number): {
  postTurnTriggerAbsolute: number;
} {
  const L = Math.max(4096, contextLength);
  const usable = Math.floor(L * (1 - OUTPUT_RESERVE_RATIO));
  return { postTurnTriggerAbsolute: Math.floor(usable * COMPACTION_THRESHOLD) };
}

export type CompactionThresholdBands = {
  /** Effective context length after safety factor (tokens). */
  contextLengthEffective: number;
  usableTokens: number;
  warnAbsolute: number;
  softAbsolute: number;
  hardAbsolute: number;
  emergencyAbsolute: number;
  /** Same as hard band: post-turn compaction trigger from real usage. */
  postTurnTriggerAbsolute: number;
};

/**
 * Per-model thresholds from OpenRouter `context_length` (cached fetch), with 0.8 safety factor.
 * Falls back to 128k when the model row is missing.
 */
export function getCompactionThresholdsForModel(
  modelId: string | null | undefined,
): CompactionThresholdBands {
  let raw = DEFAULT_MODEL_CONTEXT_FALLBACK;
  const id = modelId?.trim();
  if (id) {
    const row = getCachedOpenRouterModelRow(id);
    const cl = row?.context_length ?? row?.top_provider?.context_length;
    if (typeof cl === "number" && cl > 0) raw = cl;
  }
  const L = Math.max(4096, Math.floor(raw * MODEL_CONTEXT_SAFETY));
  const usable = Math.floor(L * (1 - OUTPUT_RESERVE_RATIO));
  return {
    contextLengthEffective: L,
    usableTokens: usable,
    warnAbsolute: Math.floor(usable * 0.55),
    softAbsolute: Math.floor(usable * 0.65),
    hardAbsolute: Math.floor(usable * COMPACTION_THRESHOLD),
    emergencyAbsolute: Math.floor(usable * 0.88),
    postTurnTriggerAbsolute: Math.floor(usable * COMPACTION_THRESHOLD),
  };
}

function mergeNestedSummary(
  prevFull: string | null | undefined,
  prevGen: number,
  newSegment: string,
): { text: string; generation: number } {
  const body = newSegment.trim();
  const hasPrior = !!prevFull?.trim();
  const nextGen = hasPrior ? prevGen + 1 : 1;
  if (!hasPrior) {
    return { text: `<summary id="${nextGen}">\n${body}\n</summary>`, generation: nextGen };
  }
  return {
    text: `<summary id="${nextGen}">\n${body}\n</summary>\n\n${prevFull!.trim()}`,
    generation: nextGen,
  };
}

export type CompactionRunOutcome =
  | {
      status: "completed";
      summaryText: string;
      lastMessageId: number;
      messagesAfterSummary: MessageForCompaction[];
    }
  | { status: "deferred"; reason: "ledger_in_progress" }
  | { status: "noop"; reason: string };

/**
 * Estimate total tokens for context (system + workspace + messages + input)
 */
export function estimateContextTokens(params: {
  systemPromptTokens: number;
  messageHistoryTokens: number;
  inputTokens?: number;
}): number {
  const { systemPromptTokens, messageHistoryTokens, inputTokens = 0 } = params;
  return systemPromptTokens + messageHistoryTokens + inputTokens;
}

/** v3.6: Per-agent compaction thresholds (token ratio). */
const AGENT_COMPACTION_THRESHOLDS: Record<string, number> = {
  main: 0.6,
  architect: 0.65,
  builder: 0.7,
  reviewer: 0.7,
  researcher: 0.75,
};

/**
 * v3.6: Trigger-based compaction. Evaluate in order; first match wins.
 * Returns true if any trigger fires.
 */
export function evaluateCompactionTriggers(params: {
  tokenRatio: number;
  exchangeCount?: number;
  contextWindowKnown?: boolean;
  toolCallsInLast6?: number;
  agentId?: string;
  hasWorkspace?: boolean;
  settingsExchangeThreshold?: number;
}): boolean {
  const {
    tokenRatio,
    exchangeCount = 0,
    contextWindowKnown = true,
    toolCallsInLast6 = 0,
    agentId,
    hasWorkspace = true,
    settingsExchangeThreshold = 6,
  } = params;

  if (tokenRatio > 0.65) return true;
  if (tokenRatio > 0.5) return true;
  if (!contextWindowKnown && exchangeCount >= settingsExchangeThreshold) return true;
  if (toolCallsInLast6 >= 8) return true;
  const threshold = agentId ? (AGENT_COMPACTION_THRESHOLDS[agentId] ?? COMPACTION_THRESHOLD) : COMPACTION_THRESHOLD;
  if (tokenRatio > threshold) return true;
  return false;
}

/**
 * Check if we should run compaction (over threshold).
 * v3.6: When triggerParams provided, uses trigger-based evaluation; otherwise single threshold.
 */
export async function shouldCompact(params: {
  chatId: number;
  messageHistoryTokens: number;
  systemPromptTokens: number;
  inputTokens?: number;
  providerId?: string;
  /** v3.6: Trigger params for multi-trigger evaluation */
  exchangeCount?: number;
  toolCallsInLast6?: number;
  agentId?: string;
  hasWorkspace?: boolean;
}): Promise<boolean> {
  const {
    chatId,
    messageHistoryTokens,
    systemPromptTokens,
    inputTokens = 0,
    providerId,
    exchangeCount,
    toolCallsInLast6,
    agentId,
    hasWorkspace = true,
  } = params;

  if (chatId < 0) return false; // Ephemeral chat - no compaction

  const total = estimateContextTokens({
    systemPromptTokens,
    messageHistoryTokens,
    inputTokens,
  });

  const pid = providerId ?? readSettings().selectedModel?.provider ?? "auto";
  const { budget } = await getEffectiveBudget(pid);
  const usableBudget = Math.floor(budget * (1 - OUTPUT_RESERVE_RATIO));
  const tokenRatio = budget > 0 ? total / usableBudget : 0;

  const settings = readSettings();
  const exchangeThreshold = settings.autoRoutingExchangeThreshold ?? 6;

  if (exchangeCount != null || toolCallsInLast6 != null) {
    return evaluateCompactionTriggers({
      tokenRatio,
      exchangeCount,
      contextWindowKnown: budget > 0,
      toolCallsInLast6,
      agentId,
      hasWorkspace,
      settingsExchangeThreshold: exchangeThreshold,
    });
  }

  const threshold = agentId ? (AGENT_COMPACTION_THRESHOLDS[agentId] ?? COMPACTION_THRESHOLD) : COMPACTION_THRESHOLD;
  return total > usableBudget * threshold;
}

/**
 * Same summarization path as runCompaction (CONTEXT_COMPACTION_* + summarization model), no DB writes.
 * Used for pre-dispatch tier context budgeting.
 */
const COMPACTION_PROTECTED_MARKERS = [
  "message_agent",
  "delegate_to_agent",
  "filesWritten",
  "[Task Progress]",
  "[Filesystem truth",
  "write_implementation_plan",
  "<delegate_to_agent",
  "<delegation",
  "<atlarix-delegation",
] as const;

function compactionMustPreserveContent(content: string): boolean {
  return COMPACTION_PROTECTED_MARKERS.some((m) => content.includes(m));
}

function contentLooksLikeToolResultForCompaction(content: string): boolean {
  return (
    /<atlarix-tool-result/i.test(content) ||
    /<atlarix-mcp-tool-result/i.test(content) ||
    /Here are the results of the tools/i.test(content) ||
    (content.length > 2500 && /tool_result|tool_calls|tool-use/i.test(content))
  );
}

/**
 * Before compaction summarization (`summarizeMessagesWithCompactionPrompt`), replace verbose tool-result
 * blobs with placeholders, walking **backwards** and keeping up to `keepRecentTokens` of tool-like
 * content at the tail. Chat streaming uses {@link pruneToolOutputsInMessages} separately (char limits).
 */
export function pruneToolOutputsBeforeCompaction<T extends { role: string; content: string }>(
  msgs: T[],
  keepRecentTokens: number,
): T[] {
  if (msgs.length === 0 || keepRecentTokens <= 0) return msgs;
  const out = msgs.map((m) => ({ ...m }));
  let recentToolTokens = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== "assistant" && m.role !== "user") continue;
    const content = m.content || "";
    if (!contentLooksLikeToolResultForCompaction(content)) continue;
    if (compactionMustPreserveContent(content)) continue;

    const t = estimateTokens(content);
    if (recentToolTokens + t <= keepRecentTokens) {
      recentToolTokens += t;
      continue;
    }

    out[i] = {
      ...m,
      content: `[Earlier tool output omitted for compaction (~${t} estimated tokens)]`,
    };
  }
  return out;
}

export async function summarizeMessagesWithCompactionPrompt(params: {
  messages: { role: string; content: string }[];
  sessionStats?: { toolCallCount?: number; delegationCount?: number };
  priorSummary?: {
    summaryText: string;
    compactionGeneration: number;
  } | null;
}): Promise<string | null> {
  const { messages, priorSummary } = params;
  if (messages.length === 0) return null;

  const forSummary = pruneToolOutputsBeforeCompaction(messages, HEAD_TOOL_TOKENS);

  const formatted = forSummary
    .map(
      (m) =>
        `${m.role === "user" ? "User" : "Assistant"}: ${(m.content || "")
          .replace(/\n/g, " ")
          .slice(0, 2000)}`,
    )
    .join("\n\n");

  const userPrompt = buildCompactionUserPromptPrefix(priorSummary ?? undefined) + formatted;

  try {
    const settings = readSettings();
    const summarizationModel = await getCompactionSummarizationModel(settings);
    const { modelClient } = await getModelClient(summarizationModel, settings);

    const result = await generateText({
      model: modelClient.model,
      system: CONTEXT_COMPACTION_SYSTEM,
      messages: [{ role: "user" as const, content: userPrompt }],
      maxTokens: 1500,
    } as Parameters<typeof generateText>[0]);

    const summaryText = result.text.trim();
    return summaryText || null;
  } catch (error) {
    logger.error("summarizeMessagesWithCompactionPrompt failed:", error);
    return null;
  }
}

/**
 * Run compaction: summarize oldest N messages, save, return summary + remaining.
 * v3.6: Accepts sessionStats for balanced model when session is complex.
 */
export async function runCompaction(params: {
  chatId: number;
  chatMessages: MessageForCompaction[];
  systemPromptTokens: number;
  inputTokens?: number;
  providerId?: string;
  /** v3.6: For balanced summarization when complex */
  sessionStats?: { toolCallCount?: number; delegationCount?: number };
  /** When set, defer compaction while the task ledger for this turn is still in progress. */
  turnId?: string | null;
  /** Post-turn path: insert a synthetic user continuation line after a successful compaction. */
  insertSyntheticContinuation?: boolean;
}): Promise<CompactionRunOutcome> {
  const {
    chatId,
    chatMessages,
    systemPromptTokens,
    inputTokens = 0,
    providerId,
    sessionStats,
    turnId,
    insertSyntheticContinuation,
  } = params;

  if (chatId < 0 || chatMessages.length < 4) {
    return { status: "noop", reason: "chat_too_small_or_ephemeral" };
  }

  if (turnId) {
    const L = getLedger(turnId);
    if (L?.finishReason === "in_progress") {
      logger.info(
        `[compaction] deferred for chat ${chatId}: ledger in_progress (turn ${turnId})`,
      );
      return { status: "deferred", reason: "ledger_in_progress" };
    }
  }

  const settings = readSettings();
  const pid = providerId ?? settings.selectedModel?.provider ?? "auto";
  const { budget } = await getEffectiveBudget(pid);
  const usableBudget = Math.floor(budget * (1 - OUTPUT_RESERVE_RATIO));
  const targetAfterCompaction = Math.floor(usableBudget * 0.5); // Leave headroom

  // Find how many messages to summarize
  let totalTokens = systemPromptTokens + inputTokens;
  let lastSummarizedIndex = -1;

  for (let i = 0; i < chatMessages.length - 1; i++) {
    const msg = chatMessages[i];
    totalTokens += estimateTokens(msg.content || "");
    const summaryEstimate = 500; // Approx tokens for summary
    const remainingMsgs = chatMessages.slice(i + 1);
    const remainingTokens = remainingMsgs.reduce(
      (acc, m) => acc + estimateTokens(m.content || ""),
      0
    );
    if (summaryEstimate + remainingTokens + systemPromptTokens + inputTokens < targetAfterCompaction) {
      lastSummarizedIndex = i;
      break;
    }
  }

  if (lastSummarizedIndex < 0 || lastSummarizedIndex >= chatMessages.length - 2) {
    return { status: "noop", reason: "insufficient_span" };
  }

  const toSummarize = chatMessages.slice(0, lastSummarizedIndex + 1);
  const messagesAfterSummary = chatMessages.slice(lastSummarizedIndex + 1);
  const lastMessageId = toSummarize[toSummarize.length - 1].id;

  const existing = await getContextSummary(chatId);
  const summaryText = await summarizeMessagesWithCompactionPrompt({
    messages: toSummarize.map((m) => ({ role: m.role, content: m.content || "" })),
    sessionStats,
    priorSummary: existing,
  });
  if (!summaryText) {
    return { status: "noop", reason: "summarize_failed" };
  }

  const merged = mergeNestedSummary(
    existing?.summaryText ?? null,
    existing?.compactionGeneration ?? 0,
    summaryText,
  );

  try {
    // Upsert summary
    await db
      .insert(chatContextSummaries)
      .values({
        chatId,
        summaryText: merged.text,
        lastMessageId,
        compactionGeneration: merged.generation,
      })
      .onConflictDoUpdate({
        target: chatContextSummaries.chatId,
        set: {
          summaryText: merged.text,
          lastMessageId,
          compactionGeneration: merged.generation,
        },
      });

    if (insertSyntheticContinuation) {
      let syn =
        "Continue from the session summary. Earlier messages were compacted into the summary; keep working toward the user’s goals.";
      if (turnId) {
        const ledger = getLedgerStateString(turnId);
        if (ledger?.trim()) {
          syn += `\n\n--- Task ledger (carry forward) ---\n${ledger.trim()}`;
        }
      }
      await db.insert(messages).values({
        chatId,
        role: "user",
        content: syn,
        isSynthetic: true,
      });
    }

    logger.info(`Compaction done for chat ${chatId}: summarized ${toSummarize.length} messages`);

    return {
      status: "completed",
      summaryText: merged.text,
      lastMessageId,
      messagesAfterSummary,
    };
  } catch (error) {
    logger.error("Compaction failed:", error);
    return { status: "noop", reason: "db_error" };
  }
}

/**
 * Get existing summary for a chat (if any)
 */
export async function getContextSummary(chatId: number): Promise<{
  summaryText: string;
  lastMessageId: number;
  compactionGeneration: number;
} | null> {
  if (chatId < 0) return null;
  const [row] = await db
    .select()
    .from(chatContextSummaries)
    .where(eq(chatContextSummaries.chatId, chatId))
    .limit(1);
  if (!row) return null;
  return {
    summaryText: row.summaryText,
    lastMessageId: row.lastMessageId,
    compactionGeneration: row.compactionGeneration ?? 0,
  };
}

// ═══════════════════════════════════════════════════════════════
// POST-TURN COMPACTION (OpenCode/Claude Code style)
// Runs after AI responds, uses real token counts. Fire-and-forget.
// ═══════════════════════════════════════════════════════════════

const lastCompactionTime = new Map<number, number>();
const MIN_COMPACTION_INTERVAL_MS = 60_000; // 1 minute between compactions

const pendingCompactionByChatId = new Map<
  number,
  { totalTokensUsed: number; providerId?: string; turnId?: string; openRouterModelId?: string | null }
>();

/**
 * Check if we should compact based on REAL token usage from API.
 * Called from onFinish after AI stream completes.
 */
export async function shouldCompactFromRealTokens(params: {
  chatId: number;
  totalTokensUsed: number;
  providerId?: string;
  /** Resolved OpenRouter model id (e.g. anthropic/claude-3.5-sonnet) when known; uses cached context_length. */
  openRouterModelId?: string | null;
}): Promise<boolean> {
  const { chatId, totalTokensUsed, providerId, openRouterModelId } = params;
  if (chatId < 0 || totalTokensUsed <= 0) return false;

  const pid = providerId ?? readSettings().selectedModel?.provider ?? "auto";
  let postTurnTriggerAbsolute: number;
  if (openRouterModelId?.trim()) {
    postTurnTriggerAbsolute =
      getCompactionThresholdsForModel(openRouterModelId.trim()).postTurnTriggerAbsolute;
  } else {
    const { budget } = await getEffectiveBudget(pid);
    postTurnTriggerAbsolute = getCompactionThresholds(budget).postTurnTriggerAbsolute;
  }
  if (totalTokensUsed < postTurnTriggerAbsolute) return false;

  const last = lastCompactionTime.get(chatId) ?? 0;
  if (Date.now() - last < MIN_COMPACTION_INTERVAL_MS) return false;

  return true;
}

async function runPostTurnCompactionAttempt(args: {
  chatId: number;
  totalTokensUsed: number;
  providerId?: string;
  turnId?: string;
  openRouterModelId?: string | null;
  /** Retry after ledger deferral: skip shouldCompactFromRealTokens (includes interval gate). */
  forceAttempt?: boolean;
}): Promise<void> {
  const { chatId, totalTokensUsed, providerId, turnId, openRouterModelId, forceAttempt } = args;
  if (chatId < 0) return;

  if (!forceAttempt) {
    const shouldRun = await shouldCompactFromRealTokens({
      chatId,
      totalTokensUsed,
      providerId,
      openRouterModelId,
    });
    if (!shouldRun) return;
  }

  logger.info(`Post-turn compaction triggered for chat ${chatId} (${totalTokensUsed} tokens)`);

  const chatMsgs = await db.query.messages.findMany({
    where: eq(messages.chatId, chatId),
    orderBy: (m, { asc }) => [asc(m.createdAt)],
    columns: { id: true, role: true, content: true },
  });

  const msgList = chatMsgs.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content || "",
  }));

  const systemEstimate = 6000;
  const result = await runCompaction({
    chatId,
    chatMessages: msgList,
    systemPromptTokens: systemEstimate,
    inputTokens: 0,
    providerId,
    turnId: turnId ?? undefined,
    insertSyntheticContinuation: true,
  });

  if (result.status === "deferred") {
    pendingCompactionByChatId.set(chatId, {
      totalTokensUsed,
      providerId,
      turnId,
      openRouterModelId,
    });
    logger.info(`Post-turn compaction deferred (ledger) for chat ${chatId}; will retry when ledger settles`);
    return;
  }

  if (result.status === "completed") {
    lastCompactionTime.set(chatId, Date.now());
    logger.info(`Post-turn compaction completed for chat ${chatId}`);
  }
}

/**
 * After the stream marks the task ledger complete, retry compaction if it was deferred for this turn.
 */
export function notifyCompactionLedgerSettled(chatId: number, turnId: string): void {
  if (chatId < 0) return;
  const p = pendingCompactionByChatId.get(chatId);
  if (!p || p.turnId !== turnId) return;
  pendingCompactionByChatId.delete(chatId);
  void runPostTurnCompactionAttempt({
    chatId,
    totalTokensUsed: p.totalTokensUsed,
    providerId: p.providerId,
    turnId: p.turnId,
    openRouterModelId: p.openRouterModelId,
    forceAttempt: true,
  }).catch((err) => logger.error("Post-turn compaction retry error:", err));
}

/**
 * Post-turn compaction: run in background after AI responds.
 * Uses real token count; compacts proactively so next user message is instant.
 */
export function schedulePostTurnCompaction(params: {
  chatId: number;
  totalTokensUsed: number;
  providerId?: string;
  appId?: number;
  turnId?: string;
  openRouterModelId?: string | null;
}): void {
  const { chatId, totalTokensUsed, providerId, turnId, openRouterModelId } = params;
  if (chatId < 0) return;

  void runPostTurnCompactionAttempt({
    chatId,
    totalTokensUsed,
    providerId,
    turnId,
    openRouterModelId,
  }).catch((err) => logger.error("Post-turn compaction error:", err));
}

// ═══════════════════════════════════════════════════════════════
// TOOL OUTPUT PRUNING
// Truncate old tool results to prevent context bloat (OpenCode style)
// ═══════════════════════════════════════════════════════════════

const TOOL_OUTPUT_MAX_CHARS = 8000; // ~2000 tokens per tool result
const KEEP_RECENT_TOOL_MESSAGES = 4; // Don't prune last N tool-result-like messages

/**
 * Prune long tool outputs in messages. Keeps recent ones; truncates old ones.
 */
export function pruneToolOutputsInMessages<T extends { role: string; content: string }>(
  msgs: T[]
): T[] {
  if (msgs.length <= KEEP_RECENT_TOOL_MESSAGES) return msgs;

  const isToolResultLike = (content: string) =>
    /Here are the results of the tools|tool_result|<\/tool_result>|<tool_result/i.test(content) ||
    content.includes("tool=\"") ||
    (content.length > 3000 && content.includes("output"));

  let toolResultCount = 0;
  return msgs.map((msg, idx) => {
    if (msg.role !== "user" && msg.role !== "assistant") return msg;
    if (!isToolResultLike(msg.content)) return msg;

    const fromEnd = msgs.length - 1 - idx;
    if (fromEnd < KEEP_RECENT_TOOL_MESSAGES) return msg; // Keep recent

    toolResultCount++;
    if (msg.content.length <= TOOL_OUTPUT_MAX_CHARS) return msg;

    const truncated = msg.content.slice(0, TOOL_OUTPUT_MAX_CHARS) +
      `\n\n[Truncated - original was ~${Math.ceil(msg.content.length / 4)} tokens. Use read_file or list_files to retrieve if needed.]`;
    return { ...msg, content: truncated };
  });
}
