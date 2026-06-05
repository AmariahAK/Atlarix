/**
 * Context Compaction - v7.1.4
 * Automatic stepped compaction that runs before every dispatch.
 * Follows OpenCode pattern: measure → prune tool outputs → strip media → LLM summarize.
 * Task NEVER stops — compaction runs transparently.
 */

import { generateText } from "ai";
import { readSettings } from "../../main/settings";
import { getModelClient } from "../../ipc/utils/get_model_client";
import { getCompactionSummarizationModel } from "../summarization_model";
import {
  CONTEXT_COMPACTION_SYSTEM,
  buildCompactionUserPromptPrefix,
} from "../../prompts/context_compaction_prompt";
import log from "electron-log";
import { getCachedOpenRouterModelRow } from "../routing/tier-context-limits";
import { exactTokenCount, exactTokenCountText } from "./token-counter";

const logger = log.scope("compaction");

// ═══════════════════════════════════════════════════════════════
// OPENCODE-STYLE CONSTANTS
// ═══════════════════════════════════════════════════════════════

export const PRUNE_MINIMUM_TOKENS = 20_000;
const DEFAULT_TAIL_TURNS = 2;
const COMPACTION_THRESHOLD = 0.75;
const PRUNE_THRESHOLD = 0.60;
const TOOL_OUTPUT_MAX_CHARS = 2_000;
const PRUNE_PROTECTED_TOOLS = ["skill"];
const MODEL_CONTEXT_SAFETY = 0.8;

/**
 * v11.1 durable compaction: summary messages are recognizable by this prefix.
 * The summary is persisted to the workspace session like any other message,
 * and dispatch slices the MODEL history from the LAST summary onward — so a
 * reload (which rehydrates the full session log) doesn't re-expand the
 * model's context. The UI keeps the full scrollback.
 */
export const COMPACTION_SUMMARY_PREFIX = "[COMPACTION MARKER]";

export function isCompactionSummaryMessage(
  content: string | null | undefined,
): boolean {
  return typeof content === "string" && content.startsWith(COMPACTION_SUMMARY_PREFIX);
}

/**
 * Model-history slice: keep [last summary message .. end]. Returns the input
 * array unchanged when no summary exists (the common case — cheap check).
 */
export function sliceFromLastCompactionSummary<
  T extends { role: string; content?: string | null },
>(messages: T[]): T[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (
      messages[i].role === "user" &&
      isCompactionSummaryMessage(messages[i].content)
    ) {
      return i === 0 ? messages : messages.slice(i);
    }
  }
  return messages;
}

interface MessageForCompaction {
  id: number;
  role: string;
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments?: string }>;
  filesWritten?: string[] | null;
}

// ═══════════════════════════════════════════════════════════════
// SUMMARY TEMPLATE (OpenCode pattern with Resume From)
// ═══════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════
// TIER CONTEXT LIMIT
// ═══════════════════════════════════════════════════════════════

const DEFAULT_MODEL_CONTEXT_FALLBACK = 128_000;

export function getTierContextLimitSync(providerId?: string): number {
  const pid = providerId ?? readSettings().selectedModel?.provider ?? "auto";
  try {
    const row = getCachedOpenRouterModelRow(pid);
    const cl = row?.context_length ?? row?.top_provider?.context_length;
    if (typeof cl === "number" && cl > 0) {
      return Math.floor(cl * MODEL_CONTEXT_SAFETY);
    }
  } catch {}
  return DEFAULT_MODEL_CONTEXT_FALLBACK;
}

// ═══════════════════════════════════════════════════════════════
// TURN-BASED SELECTION (OpenCode pattern)
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

function turns(msgs: MessageForCompaction[]): Turn[] {
  const result: Turn[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "user") continue;
    result.push({ start: i, end: msgs.length, id: msgs[i].id });
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i]!.end = result[i + 1]!.start;
  }
  return result;
}

function splitTurn(
  msgs: MessageForCompaction[],
  turn: Turn,
  budget: number,
): Tail | undefined {
  if (budget <= 0) return undefined;
  if (turn.end - turn.start <= 1) return undefined;

  for (let start = turn.start + 1; start < turn.end; start++) {
    const slice = msgs.slice(start, turn.end);
    const size = exactTokenCount(slice.map(m => ({ role: m.role, content: m.content })));
    if (size > budget) continue;
    return { start, id: msgs[start]!.id };
  }
  return undefined;
}

function preserveRecentBudget(providerId?: string): number {
  const budget = getTierContextLimitSync(providerId);
  const PRESERVE_RECENT_TOKENS = 2_000;
  const MAX_PRESERVE_RECENT_TOKENS = 8_000;
  return Math.min(
    MAX_PRESERVE_RECENT_TOKENS,
    Math.max(PRESERVE_RECENT_TOKENS, Math.floor(budget * 0.25))
  );
}

function selectMessagesForCompaction(
  msgs: MessageForCompaction[],
  providerId?: string,
): { head: MessageForCompaction[]; tail_start_id: number | undefined } {
  const budget = preserveRecentBudget(providerId);
  const all = turns(msgs);

  if (all.length === 0) return { head: msgs, tail_start_id: undefined };

  const recent = all.slice(-DEFAULT_TAIL_TURNS);
  let total = 0;
  let keep: Tail | undefined;

  for (let i = recent.length - 1; i >= 0; i--) {
    const turn = recent[i]!;
    const turnMsgs = msgs.slice(turn.start, turn.end);
    const turnSize = exactTokenCount(turnMsgs.map(m => ({ role: m.role, content: m.content })));

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

// ═══════════════════════════════════════════════════════════════
// TOOL OUTPUT PRUNING (Step 2)
// ═══════════════════════════════════════════════════════════════

function contentLooksLikeToolResult(content: string): boolean {
  return (
    /<atlarix-tool-result/i.test(content) ||
    /<atlarix-mcp-tool-result/i.test(content) ||
    /Here are the results of the tools/i.test(content) ||
    (content.length > 2500 && /tool_result|tool_calls|tool-use/i.test(content))
  );
}

function isToolProtected(content: string): boolean {
  if (content.length < 100) return false;
  return PRUNE_PROTECTED_TOOLS.some(
    (tool) => content.includes(`tool="${tool}"`) || content.includes(`tool='${tool}'`)
  );
}

function isContentProtectedForCompaction(content: string, filesWritten?: string[] | null): boolean {
  if (filesWritten && filesWritten.length > 0) return true;
  const markers = [
    "message_agent",
    "delegate_to_agent",
    "write_implementation_plan",
    "<delegate_to_agent",
    "<delegation",
    "<atlarix-delegation",
    "[Task Progress]",
    "[Filesystem truth",
  ];
  return markers.some((m) => content.includes(m));
}

export function pruneToolOutputs(
  msgs: MessageForCompaction[],
  protectRecentTokens: number,
): { messages: MessageForCompaction[]; tokensPruned: number } {
  if (msgs.length === 0) return { messages: msgs, tokensPruned: 0 };

  const minKeep = Math.max(PRUNE_MINIMUM_TOKENS, protectRecentTokens);

  let userTurns = 0;
  const out = msgs.map((m) => ({ ...m }));
  let recentToolTokens = 0;
  let tokensPruned = 0;

  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role === "user") {
      userTurns++;
      if (userTurns > 2) break;
    }
    if (m.role !== "assistant" && m.role !== "user") continue;
    const content = m.content || "";
    if (!contentLooksLikeToolResult(content)) continue;
    if (isContentProtectedForCompaction(content, m.filesWritten)) continue;
    if (isToolProtected(content)) continue;

    const t = exactTokenCountText(content);
    if (recentToolTokens + t <= minKeep) {
      recentToolTokens += t;
      continue;
    }

    tokensPruned += t;
    const truncated = content.slice(0, TOOL_OUTPUT_MAX_CHARS);
    out[i] = {
      ...m,
      content: `[Earlier tool output omitted (~${t} tokens)]${truncated.length < content.length ? `\n\n${truncated}` : ""}`,
    };
  }

  return { messages: out, tokensPruned };
}

// ═══════════════════════════════════════════════════════════════
// MEDIA STRIPPING (Step 3)
// ═══════════════════════════════════════════════════════════════

function stripMediaFromMessages(
  msgs: MessageForCompaction[],
  keepLastNTurns: number = 2,
): MessageForCompaction[] {
  const allTurns = turns(msgs);
  const turnsToKeep = allTurns.slice(-keepLastNTurns);
  const idsToKeep = new Set<number>();
  for (const turn of turnsToKeep) {
    for (let i = turn.start; i < turn.end; i++) {
      idsToKeep.add(msgs[i]!.id);
    }
  }

  return msgs.map((m) => {
    if (idsToKeep.has(m.id)) return m;
    const hasMedia = m.content.includes("[image:") ||
                     m.content.includes("[attached") ||
                     m.content.includes("data:image") ||
                     m.content.includes(".pdf");
    if (!hasMedia) return m;
    return {
      ...m,
      content: m.content
        .replace(/\[image:.*?\]/g, "[Image attachment removed for context]")
        .replace(/\[attached:.*?\]/g, "[Attachment removed for context]")
        .replace(/data:image\/[^;]+;base64,[^\s]+/g, "[Image data removed]")
        .replace(/\.pdf[^\s]*/g, "[PDF removed]"),
    };
  });
}

// ═══════════════════════════════════════════════════════════════
// LLM SUMMARIZATION (Step 4)
// ═══════════════════════════════════════════════════════════════

async function summarizeMessages(
  messages: MessageForCompaction[],
  priorSummary?: { summaryText: string; compactionGeneration: number } | null,
): Promise<string | null> {
  if (messages.length === 0) return null;

  const formatted = messages
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

    return result.text.trim() || null;
  } catch (error) {
    logger.error("summarizeMessages failed:", error);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// COMPACTION RESULT TYPES
// ═══════════════════════════════════════════════════════════════

export type CompactionStrategy = "none" | "pruned" | "stripped_media" | "summarized";

export interface RunSteppedCompactionResult {
  modelContext: MessageForCompaction[];
  strategy: CompactionStrategy;
  tokensFreed: number;
  summaryText?: string;
  usageRatio: number;
  compactionApplied: boolean;
}

// ═══════════════════════════════════════════════════════════════
// MAIN COMPACTION FUNCTION (Steps 1-5)
// ═══════════════════════════════════════════════════════════════

export async function runSteppedCompaction(
  messages: MessageForCompaction[],
  tierLimit: number,
  providerId?: string,
): Promise<RunSteppedCompactionResult> {
  if (messages.length === 0) {
    return {
      modelContext: messages,
      strategy: "none",
      tokensFreed: 0,
      usageRatio: 0,
      compactionApplied: false,
    };
  }

  const currentTokens = exactTokenCount(messages.map(m => ({ role: m.role, content: m.content })));
  const usageRatio = tierLimit > 0 ? currentTokens / tierLimit : 0;

  if (usageRatio < PRUNE_THRESHOLD) {
    return {
      modelContext: messages,
      strategy: "none",
      tokensFreed: 0,
      usageRatio,
      compactionApplied: false,
    };
  }

  let modelContext = [...messages];
  let tokensFreed = 0;
  let strategy: CompactionStrategy = "none";
  let summaryText: string | undefined;

  // Step 2: Prune tool outputs if over 60%
  if (usageRatio > PRUNE_THRESHOLD) {
    const protectBudget = preserveRecentBudget(providerId);
    const { messages: pruned, tokensPruned } = pruneToolOutputs(modelContext, protectBudget);
    if (tokensPruned > PRUNE_MINIMUM_TOKENS) {
      modelContext = pruned;
      tokensFreed = tokensPruned;
      strategy = "pruned";
    }
  }

  // Recalculate after pruning
  const tokensAfterPrune = exactTokenCount(modelContext.map(m => ({ role: m.role, content: m.content })));
  const ratioAfterPrune = tierLimit > 0 ? tokensAfterPrune / tierLimit : 0;

  // Step 3: Strip media if still over 75%
  if (ratioAfterPrune > COMPACTION_THRESHOLD) {
    const stripped = stripMediaFromMessages(modelContext);
    const strippedTokens = exactTokenCount(stripped.map(m => ({ role: m.role, content: m.content })));
    const freedByStrip = tokensAfterPrune - strippedTokens;
    if (freedByStrip > 0) {
      modelContext = stripped;
      tokensFreed += freedByStrip;
      strategy = "stripped_media";
    }
  }

  // Recalculate after media strip
  const tokensAfterStrip = exactTokenCount(modelContext.map(m => ({ role: m.role, content: m.content })));
  const ratioAfterStrip = tierLimit > 0 ? tokensAfterStrip / tierLimit : 0;

  // Step 4: LLM summarization if still over 75%
  if (ratioAfterStrip > COMPACTION_THRESHOLD) {
    const { head: headMessages, tail_start_id: tailStartId } = selectMessagesForCompaction(modelContext, providerId);

    // v11.1 guard: don't re-summarize a head that is just the previous
    // summary (nothing new to fold in) — avoids degenerate double passes.
    const headIsOnlyPriorSummary =
      headMessages.length === 1 &&
      isCompactionSummaryMessage(headMessages[0]?.content);

    if (
      !headIsOnlyPriorSummary &&
      headMessages.length > 0 &&
      headMessages.length < modelContext.length - 2
    ) {
      const existing = await getContextSummaryForProvider(providerId);
      let summary = await summarizeMessages(headMessages, existing);

      // v11.1 guard: a runaway summary defeats the purpose — cap it at 25%
      // of the budget (rare; generateText maxTokens already bounds it).
      if (summary) {
        const summaryTokens = exactTokenCountText(summary);
        const cap = Math.max(1_000, Math.floor(tierLimit * 0.25));
        if (summaryTokens > cap) {
          const keepChars = cap * 4; // ~4 chars/token
          summary = `${summary.slice(0, keepChars)}\n[summary truncated]`;
          logger.warn(
            `Compaction summary exceeded ${cap} tokens — truncated`,
          );
        }
      }

      if (summary) {
        const summaryMsg: MessageForCompaction = {
          id: -Date.now(),
          role: "user",
          content: `${COMPACTION_SUMMARY_PREFIX}\n${summary}\n[END COMPACTION]`,
        };

        const tailMessages = tailStartId
          ? modelContext.filter((m) => m.id >= tailStartId)
          : modelContext.slice(headMessages.length);

        modelContext = tailStartId
          ? [...modelContext.slice(0, headMessages.length).filter(m => m.role === "system"), summaryMsg, ...tailMessages]
          : [summaryMsg, ...tailMessages];

        const newTokens = exactTokenCount(modelContext.map(m => ({ role: m.role, content: m.content })));
        tokensFreed = tokensAfterStrip - newTokens;
        strategy = "summarized";
        summaryText = summary;

        logger.info(`Compaction summary applied: ${tokensFreed} tokens freed`);
      }
    }
  }

  return {
    modelContext,
    strategy,
    tokensFreed,
    summaryText,
    usageRatio,
    compactionApplied: strategy !== "none",
  };
}

// ═══════════════════════════════════════════════════════════════
// CONTEXT SUMMARY DB (for nested summaries)
// ═══════════════════════════════════════════════════════════════

async function getContextSummaryForProvider(
  _providerId?: string,
): Promise<{ summaryText: string; compactionGeneration: number } | null> {
  return null;
}


