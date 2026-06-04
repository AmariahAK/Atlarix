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

// ═══════════════════════════════════════════════════════════════
// OPENCODE-STYLE CONSTANTS
// ═══════════════════════════════════════════════════════════════

/** Threshold: run compaction when usage exceeds this % of usable context (after output reserve). */
const COMPACTION_THRESHOLD = 0.75;

/** Match OpenRouter tier safety: effective context = raw × this factor. */
const MODEL_CONTEXT_SAFETY = 0.8;

const DEFAULT_MODEL_CONTEXT_FALLBACK = 128_000;

/**
 * OpenCode-style compaction buffer (reserved tokens for output).
 * Matches OpenCode's COMPACTION_BUFFER = 20_000
 */
const COMPACTION_BUFFER = 20_000;

/**
 * Tool-output token budget kept verbatim at the tail of the transcript before compaction summarization.
 * Stream-time pruning (`pruneToolOutputsInMessages`) uses separate limits.
 */
export const HEAD_TOOL_TOKENS = 40_000;

/** Reserve tokens for model output when estimating */
const OUTPUT_RESERVE_RATIO = 0.2;

// OpenCode-style pruning constants
export const PRUNE_MINIMUM = 20_000;
export const PRUNE_PROTECT = 40_000;
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
 * Calculate usable context tokens (OpenCode-style).
 * Matches overflow.ts usable() function.
 */
export function getUsableTokens(modelContextLength: number, modelInputLimit?: number, maxOutputTokens: number = 4000): number {
  const context = modelContextLength;
  if (context === 0) return 0;

  const reserved = Math.min(COMPACTION_BUFFER, maxOutputTokens);
  return modelInputLimit
    ? Math.max(0, modelInputLimit - reserved)
    : Math.max(0, context - maxOutputTokens);
}

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
 * Token-only compaction gate (exchange / tool-burst triggers removed).
 */
export function evaluateCompactionTriggers(params: {
  tokenRatio: number;
  agentId?: string;
}): boolean {
  const { tokenRatio, agentId } = params;
  const threshold = agentId ? (AGENT_COMPACTION_THRESHOLDS[agentId] ?? COMPACTION_THRESHOLD) : COMPACTION_THRESHOLD;
  return tokenRatio > threshold;
}

/**
 * Check if we should run compaction (over threshold).
 * Token ratio only — uses provider usable budget from settings.
 */
export async function shouldCompact(params: {
  chatId: number;
  messageHistoryTokens: number;
  systemPromptTokens: number;
  inputTokens?: number;
  providerId?: string;
  agentId?: string;
  hasWorkspace?: boolean;
}): Promise<boolean> {
  const {
    chatId,
    messageHistoryTokens,
    systemPromptTokens,
    inputTokens = 0,
    providerId,
    agentId,
  } = params;

  if (chatId < 0) return false;

  const total = estimateContextTokens({
    systemPromptTokens,
    messageHistoryTokens,
    inputTokens,
  });

  const pid = providerId ?? readSettings().selectedModel?.provider ?? "auto";
  const { budget } = await getEffectiveBudget(pid);
  const usableBudget = Math.floor(budget * (1 - OUTPUT_RESERVE_RATIO));

  const threshold = agentId ? (AGENT_COMPACTION_THRESHOLDS[agentId] ?? COMPACTION_THRESHOLD) : COMPACTION_THRESHOLD;
  return total > usableBudget * threshold;
}

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

  // Unreachable for workspace chats (chatId < 0 returns above); the legacy
  // `messages` table was removed, so this path no longer has rows to compact.
  const chatMsgs: { id: number; role: string; content: string | null }[] = [];

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

  return msgs.map((msg, idx) => {
    if (msg.role !== "user" && msg.role !== "assistant") return msg;
    if (!isToolResultLike(msg.content)) return msg;

    const fromEnd = msgs.length - 1 - idx;
    if (fromEnd < KEEP_RECENT_TOOL_MESSAGES) return msg; // Keep recent

    if (msg.content.length <= TOOL_OUTPUT_MAX_CHARS) return msg;

    const truncated = msg.content.slice(0, TOOL_OUTPUT_MAX_CHARS) +
      `\n\n[Truncated - original was ~${Math.ceil(msg.content.length / 4)} tokens. Use read_file or list_files to retrieve if needed.]`;
    return { ...msg, content: truncated };
  });
}
