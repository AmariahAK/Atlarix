import type { ModelMessage } from "ai";
import log from "electron-log";
const logger = log.scope("tier_context_budget");
import type { LargeLanguageModel, UserSettings } from "../schemas";
import {
  summarizeMessagesWithCompactionPrompt,
  IN_TASK_SUMMARY_PREFIX,
} from "../context/compaction";
import { estimateTokens } from "../../ipc/utils/token_utils";
import { resolveModelContextLimit } from "../context/resolve-model-context-limit";
import {
  compactionWouldTrigger,
  modelMessageText,
} from "../context/mid-loop-threshold";

// Re-exported so existing callers keep importing from here.
export { compactionWouldTrigger };

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
   * Bound tool descriptions + parameter schemas for this turn.
   *
   * Required, not defaulted: this function decides what to TRIM to fit the
   * window, and it used to price the prefix without the tool surface — so it
   * believed it had ~6,700 tokens more room than it had. A silent 0 is the bug.
   */
  toolSurfaceTokens: number;
}

export interface EnforceContextBudgetResult {
  systemPrompt: string;
  limitedMessageHistory: BudgetHistoryMessage[];
  contextAssemblerBlob: string;
  /** Messages dropped without ever reaching a summary — the model is told. */
  droppedMessageCount?: number;
}

function totalPrefixTokens(prefixes: readonly ModelMessage[]): number {
  return prefixes.reduce(
    (acc, m) => acc + estimateTokens(String(m.content ?? "")),
    0,
  );
}

/**
 * What a dispatch will actually occupy.
 *
 * `toolSurfaceTokens` IS NOT OPTIONAL BY ACCIDENT. This function counted the
 * system prompt, the history and the codebase prefixes, and stopped — omitting
 * the bound tool descriptions and parameter schemas, which are ~6,700 tokens in
 * Explore and ~9,300 in Build, ride inside the same cache breakpoint, and are
 * billed on every single turn.
 *
 * That made this an UNDER-estimate feeding `enforceContextBudget`, i.e. the
 * thing that decides what to trim to fit the window. Atlarix believed it had
 * ~6,700 tokens more headroom than it had, so it could allow a dispatch that
 * overflows and compact later than it should.
 *
 * The caller computes it once per turn from `measureToolSurface`
 * (`lib/context/prompt-budget.ts`), which resolves the toolset through
 * `resolveToolsetForSession` — the same single assembly point both stream
 * branches use. Required rather than defaulted to 0, because a silent 0 here is
 * exactly the bug this parameter exists to fix.
 */
export function estimateDispatchTokens(params: {
  systemPrompt: string;
  history: BudgetHistoryMessage[];
  codebasePrefixMessages: readonly ModelMessage[];
  otherCodebasePrefixMessages: readonly ModelMessage[];
  /** Bound tool descriptions + parameter schemas for this turn's surface. */
  toolSurfaceTokens: number;
}): number {
  const msgTok = params.history.reduce(
    (acc, m) => acc + estimateTokens(m.content ?? ""),
    0,
  );
  return (
    estimateTokens(params.systemPrompt) +
    params.toolSurfaceTokens +
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

function trimContextAssemblerBlobOneStep(
  blob: string,
  userPrompt: string,
): string | null {
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
 * The pre-dispatch BACKSTOP: what to do when a request is still over the model's
 * hard limit after compaction has already run.
 *
 * IT DOES NOT SUMMARIZE, DELIBERATELY. It used to — with its own marker string
 * (`[Earlier conversation — compressed for context budget]`) that
 * `sliceFromLastCompactionSummary` does not recognise, never persisted, so every
 * summary it paid for was rebought the next turn. The previous pass replaced that
 * with a call to the shared compactor; this pass removes the call entirely,
 * because it was the WEAKER of two paths doing the same job. Compaction is owned
 * by the pre-dispatch gate in `turn-runner/context-assembly.ts`, which can do the
 * thing this function structurally cannot: compact the LIVE TRANSPORT (via
 * `executeCompressContext`'s `setMessages`) so the shrink survives into later
 * turns. All this function ever had was the per-request copy.
 *
 * What is left is the two jobs only it can do, and the ORDER, which used to be
 * backwards. Its first act was to DELETE the two oldest conversation messages
 * (`headConversation.slice(2)`), looping up to 24 times, before anything had a
 * chance to summarize them — silently, with no marker and no word to the model:
 *
 *   1. trim — the context-assembler blob inside the system prompt. Nothing else
 *             sees the prompt, so nothing else can do this.
 *   2. drop — head messages, LAST, and only when trimming still left us over the
 *             model's hard limit. Reports a count so `droppedHistoryNotice` can
 *             tell the model it lost context instead of letting it guess.
 */
export async function enforceContextBudget(
  params: EnforceContextBudgetParams,
): Promise<EnforceContextBudgetResult> {
  const { settings, codebasePrefixMessages, otherCodebasePrefixMessages } =
    params;

  let systemPrompt = params.systemPrompt;
  let limitedMessageHistory = params.limitedMessageHistory;
  let contextAssemblerBlob = params.contextAssemblerBlob;

  const { tierLimit } = await resolveModelContextLimit(
    params.effectiveModel,
    settings,
  );
  let droppedMessageCount = 0;

  const currentEstimate = () =>
    estimateDispatchTokens({
      systemPrompt,
      history: limitedMessageHistory,
      codebasePrefixMessages,
      otherCodebasePrefixMessages,
      toolSurfaceTokens: params.toolSurfaceTokens,
    });

  const overBudget = () => currentEstimate() > tierLimit;

  if (!overBudget()) {
    return { systemPrompt, limitedMessageHistory, contextAssemblerBlob };
  }

  const maxRounds = 24;
  for (let round = 0; round < maxRounds && overBudget(); round++) {
    // ── 1. Trim the context-assembler blob out of the system prompt.
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

    // ── 2. Drop, last. Only reached when compaction (which ran before this
    // function) and every blob trim still left us over the model's hard limit —
    // i.e. the protected tail alone does not fit the window.
    const entries = nonSystemEntries(limitedMessageHistory);
    const pStart = protectedEntryStartIndex(entries);
    let firstProtectedOriginalIndex =
      pStart < entries.length
        ? entries[pStart].i
        : limitedMessageHistory.length;
    // As the mid-round cut does (c3e7acd2): never open the kept tail on a TOOL
    // RESULT, whose call would be dropped with the head; a provider refuses that
    // request and every one after it. Step back to the call.
    while (
      firstProtectedOriginalIndex > 0 &&
      firstProtectedOriginalIndex < limitedMessageHistory.length &&
      limitedMessageHistory[firstProtectedOriginalIndex]?.role === "tool"
    ) {
      firstProtectedOriginalIndex--;
    }
    const head = limitedMessageHistory.slice(0, firstProtectedOriginalIndex);
    const tail = limitedMessageHistory.slice(firstProtectedOriginalIndex);
    const headConversation = head.filter((m) => m.role !== "system");
    if (!headConversation.some((m) => m.role === "user" || m.role === "assistant")) break;

    // The two oldest messages, and the results of any call among them; a kept
    // call keeps its results (they used to be dropped while the call stayed).
    let cut = 0;
    for (let n = 0; cut < headConversation.length && n < 2; cut++) {
      if (headConversation[cut].role !== "tool") n++;
    }
    while (cut < headConversation.length && headConversation[cut].role === "tool") cut++;
    const kept = headConversation.slice(cut);
    droppedMessageCount += cut;
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
  /** Window MINUS the reply reserve; falls back to `tierLimit`. */
  usableTokens?: number;
  /**
   * The turn's compaction point (threshold × working window, capped by usable) —
   * the mid-turn check's trigger, matching the pre-dispatch gate. Absent → the
   * usable budget, so a caller that hasn't computed the point still works.
   */
  compactionLimit?: number;
  /**
   * Bound tool descriptions + schemas for this turn — the half of the prefix the
   * estimate used to omit (0j: the trigger re-decided "under the point" on a
   * round the guard had already ended, because tool schemas were not counted).
   * Added on top of the message + system-prompt estimate.
   */
  toolSurfaceTokens?: number;
  /** Trigger compaction when `(systemPromptEstimate + history)` exceeds `usableTokens`. */
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
  /**
   * The model THIS turn runs on. The summary must be written by it: without it the
   * summarizer fell back to the chat's STORED model (Auto by default), which bills
   * a different model and fails outright for a BYOK user who is not signed in
   * ("Atlarix Auto isn't offered right now").
   */
  model?: { provider: string; name: string };
  /**
   * Do not summarise at or below this count. Set by a caller whose previous attempt
   * this round failed or freed too little, so a broken or useless summariser is not
   * called again on every step - only after the context has grown meaningfully.
   */
  attemptAbove?: number;
  /**
   * Summarise on the turn's own request (prefix-summary.ts): a cache read
   * instead of the whole conversation at full price. Null falls back to the
   * normal summariser.
   */
  summarizeOnPrefix?: () => Promise<string | null>;
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
  // Compact at the turn's compaction point when given (the working-window rule),
  // else near the usable limit (opencode's rule) — the window minus the room the
  // reply needs, so there is no separate ratio to tune.
  const protect = params.protectExchanges ?? 3;
  const usable = params.compactionLimit ?? params.usableTokens ?? params.tierLimit;

  const tokensOf = (m: ModelMessage) =>
    estimateTokens(modelMessageText(m.content));
  const total = (msgs: ModelMessage[]) =>
    msgs.reduce((acc, m) => acc + tokensOf(m), 0) +
    params.systemPromptEstimate +
    (params.toolSurfaceTokens ?? 0);

  const beforeTokens = total(params.nativeMessages ?? params.messages);
  if (
    beforeTokens <= usable ||
    (params.attemptAbove != null && beforeTokens <= params.attemptAbove)
  ) {
    return {
      messages: params.messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
    };
  }

  // Locate the protected suffix: walk back from the tail collecting `protect`
  // assistant->user pairs of user+assistant exchanges (mirrors the
  // `protectedEntryStartIndex` heuristic in this file).
  const entries = nonSystemEntries(
    params.messages.map((m) => ({
      role: m.role,
      content: modelMessageText(m.content),
    })),
  );
  if (entries.length === 0) {
    logger.log(`[compaction] declined over the point: no conversation entries (estimate ${beforeTokens}, point ${usable})`);
    return {
      messages: params.messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
    };
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
  let firstProtectedOriginalIndex =
    e + 1 < entries.length ? entries[e + 1].i : params.messages.length;
  // Never start the kept tail on a TOOL RESULT. The walk above runs on the
  // flattened view, where a tool result is a "user" entry, so the cut can land
  // between an assistant's tool_calls and its results; the native tail then opens
  // with a role "tool" message whose call was summarised away, and DeepSeek /
  // OpenAI reject the whole request ("Messages with role 'tool' must be a
  // response to a preceding message with 'tool_calls'"). Step back to the
  // assistant message that made the calls, so call and results stay together.
  const pairing = params.nativeMessages ?? params.messages;
  while (
    firstProtectedOriginalIndex > 0 &&
    firstProtectedOriginalIndex < pairing.length &&
    pairing[firstProtectedOriginalIndex]?.role === "tool"
  ) {
    firstProtectedOriginalIndex--;
  }

  const head = params.messages.slice(0, firstProtectedOriginalIndex);
  const tail = params.messages.slice(firstProtectedOriginalIndex);
  const headConversation = head.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );

  // Without anything to summarize, just return as-is.
  if (headConversation.length === 0) {
    logger.log(`[compaction] declined over the point: nothing before the protected tail to summarise (estimate ${beforeTokens}, point ${usable})`);
    return {
      messages: params.messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
    };
  }

  // THE one summarizer (there were two near-identical copies; the one that pruned
  // tool outputs and recorded its own token usage is the survivor).
  const summary =
    (params.summarizeOnPrefix ? await params.summarizeOnPrefix().catch(() => null) : null) ??
    (await summarizeMessagesWithCompactionPrompt({
    messages: headConversation.map((m) => ({
      role: m.role,
      content: modelMessageText(m.content),
    })),
    sessionStats: params.sessionStats,
    chatId: params.chatId,
    ...(params.model ? { model: params.model } : {}),
  }));
  if (!summary) {
    logger.log(`[compaction] declined over the point: the summariser returned nothing (estimate ${beforeTokens}, point ${usable})`);
    return {
      messages: params.messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
    };
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
