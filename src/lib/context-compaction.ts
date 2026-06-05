/**
 * Context Compaction - v7.1.2
 * When context bar fills, AI summarizes the session for continuity.
 * OpenCode/Claude Code style with enhanced token management.
 */

import { generateText } from "ai";
import { readSettings } from "../main/settings";
import { getModelClient } from "../ipc/utils/get_model_client";
import { getCompactionSummarizationModel } from "./summarization_model";
import { estimateTokens, getEffectiveBudget } from "../ipc/utils/token_utils";
import {
  CONTEXT_COMPACTION_SYSTEM,
  buildCompactionUserPromptPrefix,
} from "../prompts/context_compaction_prompt";
import log from "electron-log";
import { getLedger } from "./tasks/task-ledger";
import { getCachedOpenRouterModelRow } from "./routing/tier-context-limits";
import { recordAuxUsage } from "./usage/turn-usage-aggregator";

const logger = log.scope("context-compaction");

/**
 * v11.1: provider "context window exceeded" error classifier — providers word
 * this differently (OpenAI `context_length_exceeded`, Anthropic "prompt is
 * too long", generic 400s with "maximum context"/"too many tokens"). Used by
 * the stream catch to force one compaction round and retry the dispatch.
 */
export function isContextOverflowError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) return false;
  return /context[_\s-]?length[_\s-]?exceeded|maximum context|context window|prompt is too long|too many tokens|maximum length|input length and `max_tokens` exceed|reduce the length of the messages|exceeds the maximum number of tokens/i.test(
    message,
  );
}

// ═══════════════════════════════════════════════════════════════
// OPENCODE-STYLE CONSTANTS
// ═══════════════════════════════════════════════════════════════

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

// OpenCode-style pruning constants
export const PRUNE_MINIMUM = 20_000;
const TOOL_OUTPUT_MAX_CHARS_COMPACTION = 2_000;
const PRUNE_PROTECTED_TOOLS = ["skill"];

// OpenCode-style tail turn preservation
const DEFAULT_TAIL_TURNS = 2;
const MIN_PRESERVE_RECENT_TOKENS = 2_000;
const MAX_PRESERVE_RECENT_TOKENS = 8_000;

// ═══════════════════════════════════════════════════════════════
// OPENCODE-STYLE USABLE FUNCTION
// ═══════════════════════════════════════════════════════════════

/**
 * Get usable budget from provider/budget or model context length.
 * v7.1.2: Enhanced to mirror OpenCode's usable() function.
 */
export function getUsableBudget(providerId?: string): number {
  const pid = providerId ?? readSettings().selectedModel?.provider ?? "auto";
  const { budget } = getEffectiveBudgetSync(pid);
  return budget;
}

function getEffectiveBudgetSync(providerId: string): { budget: number } {
  try {
    const settings = readSettings();
    if (providerId === "auto" || !providerId) {
      const selected = settings.selectedModel;
      if (selected) {
        const row = getCachedOpenRouterModelRow(selected.name);
        const cl = row?.context_length ?? row?.top_provider?.context_length;
        if (typeof cl === "number" && cl > 0) {
          return { budget: Math.floor(cl * MODEL_CONTEXT_SAFETY) };
        }
      }
    }
    const row = getCachedOpenRouterModelRow(providerId);
    const cl = row?.context_length ?? row?.top_provider?.context_length;
    if (typeof cl === "number" && cl > 0) {
      return { budget: Math.floor(cl * MODEL_CONTEXT_SAFETY) };
    }
  } catch {
    // Fall through
  }
  return { budget: DEFAULT_MODEL_CONTEXT_FALLBACK };
}

interface MessageForCompaction {
  id: number;
  role: string;
  content: string;
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

// ═══════════════════════════════════════════════════════════════
// OPENCODE-STYLE TURN-BASED SELECTION
// ═══════════════════════════════════════════════════════════════

type Turn = {
  start: number;
  end: number;
  id: number;
};

type Tail = {
  start: number;
  id: number;
};

type SelectedRange = {
  head: MessageForCompaction[];
  tail_start_id: number | undefined;
};

/**
 * Identify user message boundaries as "turns" (OpenCode-style).
 * Each turn starts at a user message and ends before the next user message.
 */
function turns(msgs: MessageForCompaction[]): Turn[] {
  const result: Turn[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "user") continue;
    result.push({ start: i, end: msgs.length, id: msgs[i].id });
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start;
  }
  return result;
}

/**
 * Split a turn to fit within budget - finds the latest message index within the turn
 * that keeps total tokens under budget.
 */
function splitTurn(
  msgs: MessageForCompaction[],
  turn: Turn,
  budget: number,
): Tail | undefined {
  if (budget <= 0) return undefined;
  if (turn.end - turn.start <= 1) return undefined;

  for (let start = turn.start + 1; start < turn.end; start++) {
    const slice = msgs.slice(start, turn.end);
    const size = slice.reduce((acc, m) => acc + estimateTokens(m.content || ""), 0);
    if (size > budget) continue;
    return { start, id: msgs[start]!.id };
  }
  return undefined;
}

/**
 * Calculate the preserved recent budget (OpenCode-style).
 * Uses 25% of usable tokens, clamped between 2k-8k.
 */
function preserveRecentBudget(providerId?: string): number {
  const budget = getUsableBudget(providerId);
  return Math.min(
    MAX_PRESERVE_RECENT_TOKENS,
    Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(budget * 0.25))
  );
}

/**
 * Select which messages to keep for compaction (OpenCode-style).
 * Walks backwards through turns, keeping within preserveRecentBudget.
 * Can split within a turn for fine-grained control.
 */
export function selectMessagesForCompaction(
  msgs: MessageForCompaction[],
  providerId?: string,
): SelectedRange {
  const budget = preserveRecentBudget(providerId);
  const all = turns(msgs);

  if (all.length === 0) return { head: msgs, tail_start_id: undefined };

  const recent = all.slice(-DEFAULT_TAIL_TURNS);
  let total = 0;
  let keep: Tail | undefined;

  for (let i = recent.length - 1; i >= 0; i--) {
    const turn = recent[i]!;
    const turnMsgs = msgs.slice(turn.start, turn.end);
    const turnSize = turnMsgs.reduce((acc, m) => acc + estimateTokens(m.content || ""), 0);

    if (total + turnSize <= budget) {
      total += turnSize;
      keep = { start: turn.start, id: turn.id };
      continue;
    }

    const remaining = budget - total;
    const split = splitTurn(msgs, turn, remaining);
    if (split) keep = split;
    else if (!keep) {
      logger.info("tail fallback", { budget, turnSize, total });
    }
    break;
  }

  if (!keep || keep.start === 0) {
    return { head: msgs, tail_start_id: undefined };
  }

  return {
    head: msgs.slice(0, keep.start),
    tail_start_id: keep.id,
  };
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

function isToolProtectedForPruning(content: string): boolean {
  if (content.length < 100) return false;
  return PRUNE_PROTECTED_TOOLS.some(
    (tool) => content.includes(`tool="${tool}"`) || content.includes(`tool="${tool}"`)
  );
}

/**
 * Before compaction summarization (`summarizeMessagesWithCompactionPrompt`), replace verbose tool-result
 * blobs with placeholders, walking **backwards** and keeping up to `keepRecentTokens` of tool-like
 * content at the tail. Chat streaming uses {@link pruneToolOutputsInMessages} separately (char limits).
 * v7.1.2: Enhanced with PRUNE_MINIMUM, PRUNE_PROTECT, and protected tool list (OpenCode-style).
 */
export function pruneToolOutputsBeforeCompaction<T extends { role: string; content: string }>(
  msgs: T[],
  keepRecentTokens: number,
): T[] {
  if (msgs.length === 0) return msgs;
  const minKeep = Math.max(PRUNE_MINIMUM, keepRecentTokens);

  let userTurns = 0;
  const out = msgs.map((m) => ({ ...m }));
  let recentToolTokens = 0;

  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role === "user") {
      userTurns++;
      if (userTurns > 2) break;
    }
    if (m.role !== "assistant" && m.role !== "user") continue;
    const content = m.content || "";
    if (!contentLooksLikeToolResultForCompaction(content)) continue;
    if (compactionMustPreserveContent(content)) continue;
    if (isToolProtectedForPruning(content)) continue;

    const t = estimateTokens(content);
    if (recentToolTokens + t <= minKeep) {
      recentToolTokens += t;
      continue;
    }

    const truncated = content.slice(0, TOOL_OUTPUT_MAX_CHARS_COMPACTION);
    out[i] = {
      ...m,
      content: `[Earlier tool output omitted for compaction (~${t} estimated tokens)]${truncated.length < content.length ? `\n\n${truncated}` : ""}`,
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
  /** v10: when set, summarization tokens count toward this chat's turn usage. */
  chatId?: number;
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
    recordAuxUsage(params.chatId, result.usage, "compaction");

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
    providerId,
    sessionStats,
    turnId,
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

  // v7.1.2: Use OpenCode-style turn-based selection
  const { head: headMessages, tail_start_id: tailStartId } = selectMessagesForCompaction(chatMessages, pid);

  if (headMessages.length === 0 || headMessages.length >= chatMessages.length - 2) {
    return { status: "noop", reason: "insufficient_span" };
  }

  const toSummarize = headMessages;
  const messagesAfterSummary = tailStartId
    ? chatMessages.filter((m) => m.id >= tailStartId)
    : chatMessages.slice(headMessages.length);
  const lastMessageId = toSummarize[toSummarize.length - 1].id;

  const existing = await getContextSummary(chatId);
  const summaryText = await summarizeMessagesWithCompactionPrompt({
    messages: toSummarize.map((m) => ({ role: m.role, content: m.content || "" })),
    sessionStats,
    priorSummary: existing,
    chatId,
  });
  if (!summaryText) {
    return { status: "noop", reason: "summarize_failed" };
  }

  const merged = mergeNestedSummary(
    existing?.summaryText ?? null,
    existing?.compactionGeneration ?? 0,
    summaryText,
  );

  logger.info(
    `Compaction summarized ${toSummarize.length} messages for transport ${chatId} (in-memory only; legacy DB tables removed)`,
  );
  return {
    status: "completed",
    summaryText: merged.text,
    lastMessageId,
    messagesAfterSummary,
  };
}

/**
 * Get existing summary for a chat (if any)
 */
export async function getContextSummary(_chatId: number): Promise<{
  summaryText: string;
  lastMessageId: number;
  compactionGeneration: number;
} | null> {
  return null;
}

// v11.1: the entire POST-TURN COMPACTION section (schedulePostTurnCompaction,
// shouldCompactFromRealTokens, notifyCompactionLedgerSettled) was deleted —
// it early-returned for every real chat (chatId < 0) and read from the
// removed legacy `messages` table. Compaction is model-triggered via the
// compress_context tool, with automatic pre-dispatch/mid-loop gates and the
// overflow-recovery retry (isContextOverflowError) as backstops.
