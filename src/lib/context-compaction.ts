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
import { getSummarizationModelAsync } from "./summarization_model";
import { estimateTokens, getEffectiveBudget } from "../ipc/utils/token_utils";
import {
  CONTEXT_COMPACTION_SYSTEM,
  CONTEXT_COMPACTION_USER_PREFIX,
} from "../prompts/context_compaction_prompt";
import log from "electron-log";

const logger = log.scope("context-compaction");

/** Threshold: run compaction when usage exceeds this % of budget (0.75 = 75%) */
const COMPACTION_THRESHOLD = 0.75;

/** Reserve tokens for model output when estimating */
const OUTPUT_RESERVE_RATIO = 0.2;

interface MessageForCompaction {
  id: number;
  role: string;
  content: string;
}

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

/**
 * Check if we should run compaction (over threshold)
 */
export async function shouldCompact(params: {
  chatId: number;
  messageHistoryTokens: number;
  systemPromptTokens: number;
  inputTokens?: number;
  providerId?: string;
}): Promise<boolean> {
  const {
    chatId,
    messageHistoryTokens,
    systemPromptTokens,
    inputTokens = 0,
    providerId,
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

  return total > usableBudget * COMPACTION_THRESHOLD;
}

/**
 * Run compaction: summarize oldest N messages, save, return summary + remaining
 */
export async function runCompaction(params: {
  chatId: number;
  chatMessages: MessageForCompaction[];
  systemPromptTokens: number;
  inputTokens?: number;
  providerId?: string;
}): Promise<{
  summaryText: string;
  lastMessageId: number;
  messagesAfterSummary: MessageForCompaction[];
} | null> {
  const {
    chatId,
    chatMessages,
    systemPromptTokens,
    inputTokens = 0,
    providerId,
  } = params;

  if (chatId < 0 || chatMessages.length < 4) return null;

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
    // Not enough to compact meaningfully
    return null;
  }

  const toSummarize = chatMessages.slice(0, lastSummarizedIndex + 1);
  const messagesAfterSummary = chatMessages.slice(lastSummarizedIndex + 1);
  const lastMessageId = toSummarize[toSummarize.length - 1].id;

  const formatted = toSummarize
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${(m.content || "").replace(/\n/g, " ").slice(0, 2000)}`)
    .join("\n\n");

  const userPrompt = CONTEXT_COMPACTION_USER_PREFIX + formatted;

  try {
    const summarizationModel = await getSummarizationModelAsync(settings);
    const { modelClient } = await getModelClient(summarizationModel, settings);

    const result = await generateText({
      model: modelClient.model,
      system: CONTEXT_COMPACTION_SYSTEM,
      messages: [{ role: "user" as const, content: userPrompt }],
      maxTokens: 1500,
    });

    const summaryText = result.text.trim();
    if (!summaryText) return null;

    // Upsert summary
    await db
      .insert(chatContextSummaries)
      .values({
        chatId,
        summaryText,
        lastMessageId,
      })
      .onConflictDoUpdate({
        target: chatContextSummaries.chatId,
        set: {
          summaryText,
          lastMessageId,
        },
      });

    logger.info(`Compaction done for chat ${chatId}: summarized ${toSummarize.length} messages`);

    return {
      summaryText,
      lastMessageId,
      messagesAfterSummary,
    };
  } catch (error) {
    logger.error("Compaction failed:", error);
    return null;
  }
}

/**
 * Get existing summary for a chat (if any)
 */
export async function getContextSummary(chatId: number): Promise<{
  summaryText: string;
  lastMessageId: number;
} | null> {
  if (chatId < 0) return null;
  const [row] = await db
    .select()
    .from(chatContextSummaries)
    .where(eq(chatContextSummaries.chatId, chatId))
    .limit(1);
  if (!row) return null;
  return { summaryText: row.summaryText, lastMessageId: row.lastMessageId };
}

// ═══════════════════════════════════════════════════════════════
// POST-TURN COMPACTION (OpenCode/Claude Code style)
// Runs after AI responds, uses real token counts. Fire-and-forget.
// ═══════════════════════════════════════════════════════════════

const lastCompactionTime = new Map<number, number>();
const MIN_COMPACTION_INTERVAL_MS = 60_000; // 1 minute between compactions

/**
 * Check if we should compact based on REAL token usage from API.
 * Called from onFinish after AI stream completes.
 */
export async function shouldCompactFromRealTokens(params: {
  chatId: number;
  totalTokensUsed: number;
  providerId?: string;
}): Promise<boolean> {
  const { chatId, totalTokensUsed, providerId } = params;
  if (chatId < 0 || totalTokensUsed <= 0) return false;

  const pid = providerId ?? readSettings().selectedModel?.provider ?? "auto";
  const { budget } = await getEffectiveBudget(pid);
  const usableBudget = Math.floor(budget * (1 - OUTPUT_RESERVE_RATIO));
  const threshold = Math.floor(usableBudget * COMPACTION_THRESHOLD);
  if (totalTokensUsed < threshold) return false;

  const last = lastCompactionTime.get(chatId) ?? 0;
  if (Date.now() - last < MIN_COMPACTION_INTERVAL_MS) return false;

  return true;
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
}): void {
  const { chatId, totalTokensUsed, providerId } = params;
  if (chatId < 0) return;

  void (async () => {
    try {
      const shouldRun = await shouldCompactFromRealTokens({
        chatId,
        totalTokensUsed,
        providerId,
      });
      if (!shouldRun) return;

      lastCompactionTime.set(chatId, Date.now());
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
      });

      if (result) {
        logger.info(`Post-turn compaction completed for chat ${chatId}`);
      }
    } catch (err) {
      logger.error("Post-turn compaction error:", err);
    }
  })();
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
