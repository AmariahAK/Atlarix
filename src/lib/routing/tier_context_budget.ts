import type { ModelMessage } from "ai";
import type { LargeLanguageModel, UserSettings } from "../schemas";
import {
  summarizeMessagesWithCompactionPrompt,
  runSteppedCompaction,
  isCompactionSummaryMessage,
  IN_TASK_SUMMARY_PREFIX,
} from "../context/compaction";
import { estimateTokens } from "../../ipc/utils/token_utils";
import { resolveModelContextLimit } from "../context/resolve-model-context-limit";
import {
  COMPACTION_THRESHOLD,
  midLoopCompactionWouldTrigger,
  modelMessageText,
} from "../context/mid-loop-threshold";

// Re-exported so existing callers keep importing from here.
export { midLoopCompactionWouldTrigger, COMPACTION_THRESHOLD };

export interface BudgetHistoryMessage {
  role: string;
  content?: string;
  sourceCommitHash?: string;
  commitHash?: string;
}

export interface EnforceContextBudgetParams {
  settings: UserSettings;
  effectiveModel: LargeLanguageModel;
  userPrompt: string;
  systemPrompt: string;
  /** Exact text from ContextAssembler merged as `\n\n${blob}`; empty if none */
  contextAssemblerBlob: string;
  limitedMessageHistory: BudgetHistoryMessage[];
  codebasePrefixMessages: readonly ModelMessage[];
  otherCodebasePrefixMessages: readonly ModelMessage[];
  /**
   * The chat being dispatched, and its bound session. Required for compaction to
   * be DURABLE — without them the summary this function pays for is discarded at
   * end of turn and re-bought next turn. Optional only so existing tests that
   * exercise the trimming steps need not supply them.
   */
  chatId?: number;
  workspaceSessionId?: string | null;
}

export interface EnforceContextBudgetResult {
  systemPrompt: string;
  limitedMessageHistory: BudgetHistoryMessage[];
  contextAssemblerBlob: string;
  /** True if the shared compactor summarized at least once. */
  llmCompactionApplied?: boolean;
  /** True if that summary reached the session as a `[COMPACTION MARKER]` row. */
  summaryPersisted?: boolean;
  /** Messages dropped without ever reaching a summary — the model is told. */
  droppedMessageCount?: number;
}

function totalPrefixTokens(prefixes: readonly ModelMessage[]): number {
  return prefixes.reduce((acc, m) => acc + estimateTokens(String(m.content ?? "")), 0);
}

export function estimateDispatchTokens(params: {
  systemPrompt: string;
  history: BudgetHistoryMessage[];
  codebasePrefixMessages: readonly ModelMessage[];
  otherCodebasePrefixMessages: readonly ModelMessage[];
}): number {
  const msgTok = params.history.reduce(
    (acc, m) => acc + estimateTokens(m.content ?? ""),
    0,
  );
  return (
    estimateTokens(params.systemPrompt) +
    msgTok +
    totalPrefixTokens(params.codebasePrefixMessages) +
    totalPrefixTokens(params.otherCodebasePrefixMessages)
  );
}

type Entry = { i: number; role: string; content: string };

function nonSystemEntries(history: BudgetHistoryMessage[]): Entry[] {
  return history
    .map((m, i) => ({
      i,
      role: m.role,
      content: m.content ?? "",
    }))
    .filter((m) => m.role === "user" || m.role === "assistant");
}

/** First index in `entries` that starts the protected suffix (last 3 exchanges). */
function protectedEntryStartIndex(entries: Entry[]): number {
  if (entries.length === 0) return 0;
  let e = entries.length - 1;
  let exchanges = 0;
  while (exchanges < 3 && e >= 0) {
    if (entries[e].role === "assistant") {
      e--;
    }
    if (e < 0) break;
    if (entries[e].role === "user") {
      exchanges++;
      e--;
    } else {
      break;
    }
  }
  return Math.max(0, e + 1);
}

function replaceContextAssemblerBlob(
  systemPrompt: string,
  previousBlob: string,
  newBlob: string,
): string {
  if (!previousBlob) return systemPrompt;
  const needle = `\n\n${previousBlob}`;
  const i = systemPrompt.indexOf(needle);
  if (i < 0) return systemPrompt;
  return (
    systemPrompt.slice(0, i) +
    (newBlob.trim() ? `\n\n${newBlob}` : "") +
    systemPrompt.slice(i + needle.length)
  );
}

function trimContextAssemblerBlobOneStep(blob: string, userPrompt: string): string | null {
  const t = blob.trim();
  if (t.length < 80) return null;

  const lines = t.split("\n");
  const hintedLine = (line: string) => {
    const base = line.split(/[/\\]/).pop() ?? line;
    if (base.length < 3) return false;
    return userPrompt.includes(base);
  };

  const preferWorkspaceAndHints = lines.filter(
    (line) =>
      hintedLine(line) ||
      line.includes("[WORKSPACE:") ||
      line.startsWith("#") ||
      line.startsWith("##"),
  );
  if (preferWorkspaceAndHints.length > 0) {
    const compact = preferWorkspaceAndHints.join("\n").trim();
    if (compact.length > 0 && compact.length < t.length) {
      return compact;
    }
  }

  const withoutCompactLines = lines
    .filter((line) => !/^Key:\s*/.test(line))
    .filter((line) => !/^Structure:\s*/.test(line))
    .filter((line) => !/^Entry:\s*/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (withoutCompactLines.length > 0 && withoutCompactLines.length < t.length) {
    return withoutCompactLines;
  }

  const lastH2 = t.lastIndexOf("\n## ");
  if (lastH2 > 200) {
    return t.slice(0, lastH2).trim();
  }

  const half = Math.floor(t.length * 0.55);
  if (half < 400) {
    return t.slice(0, 400).trim();
  }
  return t.slice(0, half).trim();
}

/**
 * Pre-dispatch budgeting — one of the three triggers for the shared compactor.
 *
 * ORDER MATTERS, AND IT USED TO BE BACKWARDS. This function's first act was to
 * DELETE the two oldest conversation messages (`headConversation.slice(2)`),
 * looping up to 24 times, and only reach for a summary afterwards. So the turns
 * most likely to matter were destroyed before anything had a chance to summarize
 * them, silently, with no marker and (until `droppedHistoryNotice` existed) no
 * word to the model. Dropping is now LAST:
 *
 *   1. compact  — the shared compactor, which summarizes AND persists a marker
 *   2. trim     — the context-assembler blob inside the system prompt (only this
 *                 function can do this; the compactor never sees the prompt)
 *   3. drop     — head messages, with `droppedHistoryNotice` telling the model
 *
 * It also wrote its own marker string (`[Earlier conversation — compressed for
 * context budget]`) which `sliceFromLastCompactionSummary` does not recognise, and
 * never persisted it — so every summary it paid for was rebought the next turn.
 * Both are gone: the compactor owns the marker and the durable write.
 */
export async function enforceContextBudget(
  params: EnforceContextBudgetParams,
): Promise<EnforceContextBudgetResult> {
  const { settings, codebasePrefixMessages, otherCodebasePrefixMessages } = params;

  let systemPrompt = params.systemPrompt;
  let limitedMessageHistory = params.limitedMessageHistory;
  let contextAssemblerBlob = params.contextAssemblerBlob;

  const { tierLimit } = await resolveModelContextLimit(
    params.effectiveModel,
    settings,
  );
  let llmCompactionApplied = false;
  let summaryPersisted = false;
  let droppedMessageCount = 0;

  const currentEstimate = () =>
    estimateDispatchTokens({
      systemPrompt,
      history: limitedMessageHistory,
      codebasePrefixMessages,
      otherCodebasePrefixMessages,
    });

  const overBudget = () => currentEstimate() > tierLimit;

  if (!overBudget()) {
    return { systemPrompt, limitedMessageHistory, contextAssemblerBlob };
  }

  // ── 1. Compact — ONCE per dispatch, outside the loop.
  //
  // Deliberately not inside the round loop. `force: true` bypasses the ratio gate
  // (we are already over the model's hard limit, so waiting for it would be
  // circular), which means a second round would summarize a second time in the
  // SAME dispatch: two provider calls and two `[COMPACTION MARKER]` rows for one
  // turn. The compactor's `headIsOnlyPriorSummary` guard catches the degenerate
  // case where the whole head is the previous summary, but not the case where a
  // long tail leaves real messages in the head. Compaction is a per-turn event;
  // the loop below is for the cheap steps that can usefully repeat.
  //
  // The compactor runs its own cheap steps first (microcompact → prune tool
  // outputs → strip media) before spending anything on a summary.
  {
    const beforeCompaction = limitedMessageHistory.length;
    const stepped = await runSteppedCompaction(
      limitedMessageHistory.map((m, i) => ({
        id: i,
        role: m.role,
        content: m.content ?? "",
      })),
      tierLimit,
      undefined,
      {
        force: true,
        alreadyUsedTokens: estimateTokens(systemPrompt),
        chatId: params.chatId,
        workspaceSessionId: params.workspaceSessionId,
      },
    );
    if (stepped.compactionApplied) {
      // Map back onto the caller's shape. Rows the compactor kept keep their
      // ORIGINAL object — and so their commitHash / native-envelope fields, which
      // revert-to-turn depends on — with only content replaced. The summary row it
      // introduced carries a negative id and has no counterpart, so it is added as
      // a bare {role, content}.
      limitedMessageHistory = stepped.modelContext.map((m) =>
        m.id >= 0 && m.id < beforeCompaction && !isCompactionSummaryMessage(m.content)
          ? { ...limitedMessageHistory[m.id], content: m.content ?? "" }
          : { role: m.role, content: m.content ?? "" },
      );
      if (stepped.strategy === "summarized") {
        llmCompactionApplied = true;
        summaryPersisted = stepped.summaryPersisted;
      }
    }
  }

  const maxRounds = 24;
  for (let round = 0; round < maxRounds && overBudget(); round++) {
    // ── 2. Trim the context-assembler blob out of the system prompt.
    if (contextAssemblerBlob.trim()) {
      const prev = contextAssemblerBlob;
      const trimmed = trimContextAssemblerBlobOneStep(
        contextAssemblerBlob,
        params.userPrompt,
      );
      if (trimmed != null && trimmed !== prev) {
        systemPrompt = replaceContextAssemblerBlob(systemPrompt, prev, trimmed);
        contextAssemblerBlob = trimmed;
      }
    }

    if (!overBudget()) break;

    // ── 3. Drop, last. Only reached when a summary and every trim still left us
    // over the model's hard limit, i.e. the protected tail alone does not fit.
    const entries = nonSystemEntries(limitedMessageHistory);
    const pStart = protectedEntryStartIndex(entries);
    const firstProtectedOriginalIndex =
      pStart < entries.length ? entries[pStart].i : limitedMessageHistory.length;
    const head = limitedMessageHistory.slice(0, firstProtectedOriginalIndex);
    const tail = limitedMessageHistory.slice(firstProtectedOriginalIndex);
    const headConversation = head.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );
    if (headConversation.length === 0) break;

    const kept = headConversation.slice(2);
    droppedMessageCount += headConversation.length - kept.length;
    limitedMessageHistory = [
      ...head.filter((m) => m.role === "system"),
      ...kept,
      ...tail,
    ];
  }

  return {
    systemPrompt,
    limitedMessageHistory,
    contextAssemblerBlob,
    llmCompactionApplied,
    summaryPersisted,
    droppedMessageCount,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// MID-TURN AGENTIC-LOOP COMPACTION
// ════════════════════════════════════════════════════════════════════════════

/** Extract the text portion of a ModelMessage's content for estimation/summary. */
export interface MidLoopCompactionParams {
  /** Mutable list of agentic-loop messages (ModelMessage shape; we only require role + content). */
  messages: ModelMessage[];
  /** Estimated tokens used by the system prompt + any prefix messages we cannot trim here. */
  systemPromptEstimate: number;
  /** Effective per-dispatch limit (from `resolveModelContextLimit`). */
  tierLimit: number;
  /** Catalog raw context length; when set, fill ratio uses this instead of `tierLimit`. */
  contextWindowTokens?: number;
  /** Trigger compaction when `(systemPromptEstimate + history) >= threshold * limitDenom`. */
  threshold?: number;
  /** Last N protected user+assistant exchanges (default 3 — matches `enforceTierContextBudget`). */
  protectExchanges?: number;
  /**
   * Stage 3b (opencode-alignment): the ORIGINAL native messages (1:1 with
   * `messages`, which is the flattened-for-summarization view). When provided,
   * the protected tail is reconstructed from these NATIVE blocks instead of the
   * flattened prose — so recent tool results stay full-fidelity `tool` parts and
   * the model never loses them mid-turn (only the summarized head is lossy).
   */
  nativeMessages?: ModelMessage[];
  /** Optional session stats forwarded to the compaction model. */
  sessionStats?: { toolCallCount?: number; delegationCount?: number };
  /** v10: when set, summarization tokens count toward this chat's turn usage. */
  chatId?: number;
}

export interface MidLoopCompactionResult {
  messages: ModelMessage[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
}

/**
 * In-loop compaction for the SMART AGENTIC TOOL LOOP. Estimates the token weight
 * of `agenticMessages` plus the system prompt; if it crosses `threshold` of the
 * model's context window (or `tierLimit` when `contextWindowTokens` is omitted),
 * replaces older user+assistant turns with a single summary
 * `protectExchanges` user+assistant exchanges (= most recent tool result) are
 * always preserved verbatim so the model can keep reasoning.
 *
 * If compaction is unnecessary or the summarizer call fails, the messages are
 * returned unchanged (`compacted: false`).
 */
/**
 * Cheap predicate mirroring the EXACT trigger inside `compactAgenticMessagesIfNeeded`
 * (same `estimateTokens`/`modelMessageText` so it can't drift). Lets callers decide
 * whether compaction will run BEFORE emitting any "summarizing" UI — avoids showing a
 * summarize card on every loop iteration when we're nowhere near the threshold.
 */
export async function compactAgenticMessagesIfNeeded(
  params: MidLoopCompactionParams,
): Promise<MidLoopCompactionResult> {
  // Stage 3a: overflow-only (0.9, was 0.75) — mirrors opencode's "compact only
  // near the usable limit". Fires far less often; combined with native-tail
  // preservation below, mid-loop compaction is no longer a coherence hazard.
  const threshold = params.threshold ?? COMPACTION_THRESHOLD;
  const protect = params.protectExchanges ?? 3;
  const limitDenom = params.contextWindowTokens ?? params.tierLimit;

  const tokensOf = (m: ModelMessage) => estimateTokens(modelMessageText(m.content));
  const total = (msgs: ModelMessage[]) =>
    msgs.reduce((acc, m) => acc + tokensOf(m), 0) + params.systemPromptEstimate;

  const beforeTokens = total(params.messages);
  if (beforeTokens < threshold * limitDenom) {
    return { messages: params.messages, compacted: false, beforeTokens, afterTokens: beforeTokens };
  }

  // Locate the protected suffix: walk back from the tail collecting `protect`
  // assistant->user pairs of user+assistant exchanges (mirrors the
  // `protectedEntryStartIndex` heuristic in this file).
  const entries = nonSystemEntries(
    params.messages.map((m) => ({ role: m.role, content: modelMessageText(m.content) })),
  );
  if (entries.length === 0) {
    return { messages: params.messages, compacted: false, beforeTokens, afterTokens: beforeTokens };
  }
  let e = entries.length - 1;
  let exchanges = 0;
  while (exchanges < protect && e >= 0) {
    if (entries[e].role === "assistant") {
      e--;
    }
    if (e < 0) break;
    if (entries[e].role === "user") {
      exchanges++;
      e--;
    } else {
      break;
    }
  }
  const firstProtectedOriginalIndex =
    e + 1 < entries.length ? entries[e + 1].i : params.messages.length;

  const head = params.messages.slice(0, firstProtectedOriginalIndex);
  const tail = params.messages.slice(firstProtectedOriginalIndex);
  const headConversation = head.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );

  // Without anything to summarize, just return as-is.
  if (headConversation.length === 0) {
    return { messages: params.messages, compacted: false, beforeTokens, afterTokens: beforeTokens };
  }

  // THE one summarizer (there were two near-identical copies; the one that pruned
  // tool outputs and recorded its own token usage is the survivor).
  const summary = await summarizeMessagesWithCompactionPrompt({
    messages: headConversation.map((m) => ({
      role: m.role,
      content: modelMessageText(m.content),
    })),
    sessionStats: params.sessionStats,
    chatId: params.chatId,
  });
  if (!summary) {
    return { messages: params.messages, compacted: false, beforeTokens, afterTokens: beforeTokens };
  }

  // Deliberately the IN-TASK prefix, not COMPACTION_SUMMARY_PREFIX, and
  // deliberately not persisted. This summary exists to keep the current tool loop
  // inside the window; it is written for "what does the model need to finish this
  // iteration", which is the wrong brief for "what does someone need to resume
  // this conversation tomorrow". Giving it the durable marker would make
  // `sliceFromLastCompactionSummary` cut a reopened session at a boundary chosen
  // for a loop that had already ended. The turn-end trigger
  // (`enforceContextBudget`) owns the durable write; both prefixes are defined in
  // `context/compaction.ts` so the distinction stays a decision rather than an
  // accident of two call sites inventing their own strings.
  const summaryMsg: ModelMessage = {
    role: "user",
    content: `${IN_TASK_SUMMARY_PREFIX}\n${summary}`,
  };
  // Stage 3b: reconstruct the protected tail (and head system messages) from the
  // ORIGINAL native messages when provided (1:1 index with the flattened input),
  // so recent tool results keep their native `tool` blocks instead of becoming
  // flattened/truncated prose. Falls back to the flattened tail otherwise.
  const native = params.nativeMessages;
  const headSystem = (native ?? params.messages)
    .slice(0, firstProtectedOriginalIndex)
    .filter((m) => m.role === "system");
  const protectedTail = native
    ? native.slice(firstProtectedOriginalIndex)
    : tail;
  const newMessages = [...headSystem, summaryMsg, ...protectedTail];
  const afterTokens = total(newMessages);
  return {
    messages: newMessages,
    compacted: true,
    beforeTokens,
    afterTokens,
  };
}
