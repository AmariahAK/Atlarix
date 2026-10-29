/**
 * Context Compaction — THE compactor (v14.39.0).
 *
 * Steps, cheapest first, opencode's order: measure → microcompact → prune tool
 * outputs → strip media → LLM summarize. A task NEVER stops for this; compaction
 * runs transparently and, when it summarizes, writes its own durable marker.
 *
 * ONE IMPLEMENTATION, THREE TRIGGERS.
 * This header used to claim it "runs before every dispatch". It did not — it had
 * two callers, both reactive (the model calling `compress_context`, and recovery
 * after a provider had already rejected the request). The pre-dispatch and
 * mid-turn paths each had their OWN summarize-and-splice code in
 * `routing/tier_context_budget.ts`, with their own thresholds (1.0 and 0.9 against
 * this file's 0.75) and their own marker strings — neither of which
 * `sliceFromLastCompactionSummary` recognises and neither of which was persisted.
 * So the two automatic paths paid for a real summary every turn and threw it away,
 * while `dropped-history-notice.ts` documented a pipeline that did not include
 * this file at all. Both docs were half right and the money was real.
 *
 * Now: `runSteppedCompaction` is the only thing that summarizes, and the three
 * triggers are just *when* it is called —
 *   · pre-dispatch budget  → enforceContextBudget       (tier_context_budget.ts)
 *   · mid-turn loop        → compactAgenticMessagesIfNeeded (same file)
 *   · model-initiated      → compress_context           (tools/workspace.ts)
 * plus overflow recovery, which is the same call with the gates forced.
 * One budget (`usable` — the window minus the room the reply needs), one marker
 * (COMPACTION_SUMMARY_PREFIX), one durable write (persistCompactionSummaryToSession,
 * owned here). Every step below sizes itself as a FRACTION of that budget rather
 * than against a fixed token count: five absolute constants used to live here, and
 * on a small window each one silently switched its own step off. See
 * `compactionBudgets` in `mid-loop-threshold.ts`.
 */

import { generateText } from "ai";
import { readSettings } from "../../main/settings";
import { getModelClient } from "../../ipc/utils/get_model_client";
import { getCompactionSummarizationModel, turnModelForChat } from "../summarization_model";
import {
  CONTEXT_COMPACTION_SYSTEM,
  buildCompactionUserPromptPrefix,
} from "../../prompts/context_compaction_prompt";
import log from "electron-log";
import { exactTokenCount, exactTokenCountText } from "./token-counter";
import { recordAuxUsage } from "../usage/turn-usage-aggregator";
import { compactionBudgets, usableContextBudget } from "./mid-loop-threshold";
import {
  COMPACTION_MARKER_KIND,
  COMPACTION_SUMMARY_PREFIX,
  isCompactionSummaryMessage,
} from "../chat/compaction-marker";

const logger = log.scope("compaction");

// ═══════════════════════════════════════════════════════════════
// OPENCODE-STYLE CONSTANTS
// ═══════════════════════════════════════════════════════════════

/**
 * @deprecated Kept only for callers that still import it. The pruner now derives
 * its protection from `compactionBudgets(usable).pruneProtectRecent`.
 *
 * As a fixed number this was the single biggest reason compaction did nothing on
 * a small window: it protected the most recent 20,000 tokens of tool output even
 * when the ENTIRE budget was 16,000, so a 19,000-token message was kept whole and
 * every later step then had nothing left to work with.
 */
export const PRUNE_MINIMUM_TOKENS = 20_000;
/**
 * The summarize threshold is OWNED BY `mid-loop-threshold.ts`, the dependency-light
 * leaf, so the number's own test does not have to import this file's provider and
 * keychain chain. One number, three triggers — see that module for why 0.9.
 *
 * The denominator is `tierLimit`, which IS the raw context window in the normal
 * case: `overflowClampFor` defaults to 1 and only shrinks after an observed
 * provider overflow (see resolve-model-context-limit.ts).
 */
const PRUNE_THRESHOLD = 0.6;
/**
 * Everything below is derived from the USABLE budget, not fixed.
 *
 * The rule this file kept breaking: a protection floor must never exceed the
 * budget it is protecting space within. See `compactionBudgets` in
 * `mid-loop-threshold.ts` for the numbers and the measurement that produced them.
 */
const TOOL_OUTPUT_MAX_CHARS = 2_000;
const PRUNE_PROTECTED_TOOLS = ["skill"];

/**
 * The marker's identity lives in `lib/chat/compaction-marker.ts`, a leaf, because
 * the RENDERER needs the same predicate and must not import this module's `ai` /
 * settings / keychain chain. Re-exported here so every existing importer and the
 * "one marker" story stay put.
 */
export {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_MARKER_KIND,
  isCompactionSummaryMessage,
} from "../chat/compaction-marker";

/**
 * The MID-TURN summary's prefix — the one deliberate exception to "one marker".
 *
 * A mid-loop summary is written to keep a tool loop inside the context window and
 * is discarded when the turn ends. It must NOT carry
 * `COMPACTION_SUMMARY_PREFIX`, because that prefix is what
 * `sliceFromLastCompactionSummary` cuts a REOPENED session at — and cutting there
 * would resume tomorrow's conversation from a summary written for the tail end of
 * an iteration that has already finished.
 *
 * It lives here, next to the durable marker, so the two are visibly one decision.
 * Before v14.39.0 each of the three compaction paths invented its own string at
 * its own call site, which is how two of them ended up with markers that nothing
 * recognised and nothing persisted.
 */
export const IN_TASK_SUMMARY_PREFIX =
  "[Earlier in-task conversation — compressed for context budget]";

/**
 * Model-history slice: keep [last summary message .. end]. Returns the input
 * array unchanged when no summary exists (the common case — cheap check).
 *
 * RETURN IDENTITY IS LOAD-BEARING. `token_count_handlers` decides whether to
 * bypass its delta cache with `modelFacing.length === ordered.length`, so the
 * no-match and `i === 0` cases must keep returning the input array itself.
 *
 * ONCE A LIST HAS A FLAGGED MARKER, TEXT STOPS COUNTING. A session compacted
 * since v14.39.1 has a row with `kind = "compaction_marker"`, which proves the
 * column is being written for this session — so any OTHER row that merely looks
 * like a marker is text pretending, and is ignored. A legacy session with no
 * flagged row keeps the old text behaviour. This is what actually closes the
 * forgery, rather than just labelling the real one.
 */
export function sliceFromLastCompactionSummary<
  T extends { role: string; content?: string | null; kind?: string | null },
>(messages: T[]): T[] {
  const hasFlagged = messages.some(
    (m) => m.role === "user" && m.kind === COMPACTION_MARKER_KIND,
  );
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const isMarker = hasFlagged
      ? m.kind === COMPACTION_MARKER_KIND
      : isCompactionSummaryMessage(m);
    if (isMarker) {
      return i === 0 ? messages : messages.slice(i);
    }
  }
  return messages;
}

/** Closes a summary body. Written by the compactor, stripped on the way back in. */
const COMPACTION_SUMMARY_SUFFIX = "[END COMPACTION]";

/**
 * Told to the agent alongside every summary: the detail is RECOVERABLE.
 *
 * Without this the tool exists and goes unused. A model handed a summary has no
 * way to know the turns behind it are still on disk and searchable — the honest
 * default assumption is that they are gone, which is what the summary looks like.
 *
 * Deliberately placed AFTER `COMPACTION_SUMMARY_SUFFIX`: `extractPriorSummary`
 * cuts the body at the last suffix occurrence, so this line reaches the agent
 * every turn but is never folded into the next generation's summary as though it
 * were session content.
 */
const COMPACTION_RECOVERY_HINT =
  "Detail omitted above is not lost — it is still in this session's transcript. " +
  "Use `session_search` to retrieve a specific fact (an exact path, an error string, a decision) " +
  "instead of guessing or asking the user to repeat it. Do not use it to re-read the conversation wholesale.";

/**
 * Durable copy of a compaction summary into the bound session, so a reload (and
 * the dispatch funnel's `sliceFromLastCompactionSummary`) keeps the compact
 * history. Returns true when the `[COMPACTION MARKER]` row was actually written.
 *
 * WHY THIS LIVES IN THE COMPACTOR AND NOT AT A CALL SITE.
 * It used to sit in `lib/tools/workspace.ts`, which meant durability was a thing
 * each caller had to remember — and only ONE of the three ever did. The other two
 * (`enforceContextBudget` pre-dispatch, `compactAgenticMessagesIfNeeded` mid-turn)
 * each paid for a real LLM summary, wrote their own ad-hoc marker string, and
 * threw the result away at end of turn; the next turn rebuilt the full history
 * from the session log and paid again. Owning the write here makes durability a
 * property of compacting rather than an obligation on whoever calls it.
 */
async function persistCompactionSummaryToSession(
  chatId: number | undefined,
  afterList: Array<{
    role: string;
    content?: string | null;
    kind?: string | null;
  }>,
  sessionId?: string | null,
): Promise<boolean> {
  try {
    const summaryMsg = afterList.find(
      (m) => m.role === "user" && isCompactionSummaryMessage(m),
    );
    if (!summaryMsg?.content) return false;
    const {
      resolveOrBindWorkspaceSessionForStream,
      persistWorkspaceSessionUserMessage,
    } = await import("@/ipc/handlers/workspace_session_handlers");
    const resolvedSessionId =
      sessionId ??
      (chatId != null
        ? await resolveOrBindWorkspaceSessionForStream({ chatId })
        : null);
    if (!resolvedSessionId) {
      logger.warn(
        `[compaction] No workspace session id to persist summary (chat ${String(chatId)}); reopened session will not stay compacted.`,
      );
      return false;
    }
    // The whole point of the column: the row identifies itself, so nothing
    // downstream has to trust that its first bytes were written by us.
    await persistWorkspaceSessionUserMessage(
      resolvedSessionId,
      summaryMsg.content,
      { kind: COMPACTION_MARKER_KIND },
    );
    logger.info(
      `[compaction] Summary persisted to session ${resolvedSessionId}`,
    );
    return true;
  } catch (err) {
    logger.warn("[compaction] Could not persist summary to session:", err);
    return false;
  }
}

export { persistCompactionSummaryToSession };

/**
 * How many times this conversation has been summarized. Generation 1 is the
 * first pass; each later pass folds the previous summary forward rather than
 * restating it. Written into the marker line as ` gen=N`, which `startsWith`
 * matching ignores — so `isCompactionSummaryMessage`,
 * `sliceFromLastCompactionSummary` and every already-persisted row keep working.
 * A legacy marker with no `gen=` reads as generation 1.
 */
export type PriorCompactionSummary = {
  summaryText: string;
  compactionGeneration: number;
};

// Built from the constant, not written out again. The literal used to appear
// here a second time, so a change to the prefix would have silently stopped
// generation numbers parsing while detection carried on working.
const GENERATION_RE = new RegExp(
  `^${COMPACTION_SUMMARY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*gen=(\\d+)`,
);

/**
 * Split the previous compaction summary out of a message list.
 *
 * WHY THIS EXISTS. `CONTEXT_COMPACTION_SYSTEM` promises the model that when a
 * PRIOR SUMMARY is supplied it should "update it by preserving still-true
 * details, removing stale ones, and merging in new facts", and
 * `buildCompactionUserPromptPrefix` has a whole branch for that. None of it ever
 * ran: the only resolver was a `return null` stub and no caller passed a prior
 * summary. The previous summary DID still reach the next pass — the dispatch
 * slice keeps the marker — but as an ordinary message, so it was unlabelled and
 * then flattened and cut at 2,000 chars like any other line. Generation 3 was
 * compressing a truncated, structureless read of generation 2, and a long
 * session's `## Goal` drifted toward whatever it was doing an hour ago.
 *
 * Pulling it out here means the summarizers hand it to the prompt builder as a
 * labelled prior summary (which budgets 12,000 chars for it) instead of feeding
 * it through the per-message truncator.
 */
export function extractPriorSummary<
  T extends { role: string; content?: string | null; kind?: string | null },
>(messages: T[]): { prior: PriorCompactionSummary | null; rest: T[] } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content;
    // `role === "user"` matches sliceFromLastCompactionSummary exactly. If the
    // two disagreed about which row is the summary — say an assistant quoted
    // the marker back — dispatch would slice from one place and the summarizer
    // would fold in another. Passing the MESSAGE (not just its content) keeps
    // that true now that the marker is identified by its `kind`.
    if (messages[i]?.role !== "user") continue;
    if (!isCompactionSummaryMessage(messages[i])) continue;

    const generation = Number(GENERATION_RE.exec(content!)?.[1] ?? 1);
    let body = content!.slice(COMPACTION_SUMMARY_PREFIX.length);
    // Drop the `gen=N` token when present, then the newline the marker adds.
    body = body.replace(/^\s*gen=\d+/, "").replace(/^\r?\n/, "");
    const end = body.lastIndexOf(COMPACTION_SUMMARY_SUFFIX);
    if (end !== -1) body = body.slice(0, end);

    const summaryText = body.trim();
    if (!summaryText) return { prior: null, rest: messages };

    return {
      prior: {
        summaryText,
        compactionGeneration: Number.isFinite(generation) ? generation : 1,
      },
      rest: [...messages.slice(0, i), ...messages.slice(i + 1)],
    };
  }
  return { prior: null, rest: messages };
}

interface MessageForCompaction {
  id: number;
  role: string;
  content: string;
  /**
   * "compaction_marker" on the summary row. Set on the IN-MEMORY object too, not
   * only on the DB row: `executeCompressContext` and `forceCompactEphemeralChat`
   * push this straight into the live transport, so without it the marker would be
   * unidentifiable-by-column until the next reload.
   */
  kind?: string;
  toolCalls?: Array<{ id: string; name: string; arguments?: string }>;
  filesWritten?: string[] | null;
}

// ═══════════════════════════════════════════════════════════════
// SUMMARY TEMPLATE (OpenCode pattern with Resume From)
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// TIER CONTEXT LIMIT
// ═══════════════════════════════════════════════════════════════

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
    const size = exactTokenCount(
      slice.map((m) => ({ role: m.role, content: m.content })),
    );
    if (size > budget) continue;
    return { start, id: msgs[start]!.id };
  }
  return undefined;
}

/**
 * How much recent conversation is kept verbatim.
 *
 * The 2,000/8,000 clamps that used to bound this were absolutes: on a 16,000-token
 * budget the 8,000 ceiling let HALF the budget be unprotectable-from, and the
 * 2,000 floor could exceed a tiny budget outright. Derived from `usable` now, so
 * it is a share of what there is.
 */
function preserveRecentBudget(usable: number): number {
  return compactionBudgets(usable).preserveRecent;
}

/**
 * Split the history into a HEAD to summarise and a TAIL to keep verbatim.
 *
 * PROTECTION IS A TOKEN BUDGET, NOT A TURN COUNT. It used to take the last
 * `DEFAULT_TAIL_TURNS = 2` turns and, if they did not fit `preserveRecentBudget`,
 * try to split inside the newest turn — and when THAT failed, select no tail at
 * all, which made `head = everything` and let the caller's count precondition
 * refuse. Two turns can be 200 tokens or 40,000; the rule could not tell.
 *
 * Measured 2026-08-31: a 4-message session of ~41,000 tokens against a 16,000-token
 * cap, whose newest assistant turn was 22,348 tokens on its own. The newest turn
 * could not fit a 4,000-token protection budget, no split fit either, so nothing
 * was protected, everything became head, and compaction refused. A message was
 * untouchable purely because it was RECENT, at any fill level.
 *
 * Now: walk back accumulating tokens until the budget is spent, and when even the
 * newest assistant turn will not fit, PROTECT LESS rather than abandon — an
 * oversized recent turn falls into the head, where the summariser handles it like
 * any other history. That is also why there is no separate "oversized message"
 * mechanism: being recent stops being unconditional protection.
 *
 * The one thing always protected is the last USER message, however small. A tail
 * of nothing means summarising the request the model is currently answering.
 */
function selectMessagesForCompaction(
  msgs: MessageForCompaction[],
  usable: number,
): { head: MessageForCompaction[]; tail_start_id: number | undefined } {
  const budget = preserveRecentBudget(usable);
  const all = turns(msgs);
  if (all.length === 0) return { head: msgs, tail_start_id: undefined };

  const sizeOf = (turn: Turn) =>
    exactTokenCount(
      msgs
        .slice(turn.start, turn.end)
        .map((m) => ({ role: m.role, content: m.content })),
    );

  let total = 0;
  let keep: Tail | undefined;

  // Newest first, for as many whole turns as the budget affords — no turn CAP,
  // so a long tail of small turns is protected as cheaply as it deserves.
  for (let i = all.length - 1; i >= 0; i--) {
    const turn = all[i]!;
    const turnSize = sizeOf(turn);
    if (total + turnSize <= budget) {
      total += turnSize;
      keep = { start: turn.start, id: turn.id };
      continue;
    }
    // Does part of this turn fit?
    const split = splitTurn(msgs, turn, budget - total);
    if (split) keep = split;
    break;
  }

  // Nothing fit — the newest turn alone is bigger than the whole protection
  // budget. Protect the last user message and let the oversized assistant turn be
  // summarised, instead of protecting everything and compacting nothing.
  if (!keep) {
    const lastUser = all[all.length - 1];
    if (lastUser && lastUser.start > 0) {
      logger.info(
        `[compaction] newest turn exceeds the ${budget}-token protection budget — protecting the last user message only`,
      );
      keep = { start: lastUser.start, id: lastUser.id };
    }
  }

  if (!keep || keep.start === 0) {
    return { head: msgs, tail_start_id: undefined };
  }
  return { head: msgs.slice(0, keep.start), tail_start_id: keep.id };
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
    (tool) =>
      content.includes(`tool="${tool}"`) || content.includes(`tool='${tool}'`),
  );
}

function isContentProtectedForCompaction(
  content: string,
  filesWritten?: string[] | null,
): boolean {
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

  // NOT `Math.max(20_000, …)`. That fixed floor protected more tool output than a
  // small budget contains, so on a 16,000-token cap a 19,000-token message was
  // kept whole and the pruner freed nothing. The caller passes a budget-derived
  // number; the floor may never exceed the budget it protects space within.
  const minKeep = protectRecentTokens;

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
// MICROCOMPACT (Step 1.5) — no-LLM drop of stale tool outputs
// ═══════════════════════════════════════════════════════════════

/**
 * Drop (not truncate) tool outputs older than the last `keepRecentTurns` user
 * turns. Unlike `pruneToolOutputs` (which keeps a 2K slice), this replaces a
 * stale tool result with a minimal marker — freeing the most tokens for the
 * least cost, with NO LLM call. Runs before truncation + summarization so we
 * often get back under budget without ever invoking the summarizer.
 *
 * Safe only on this string-content representation: here tool results are
 * embedded as text inside assistant/user messages, so dropping one cannot
 * orphan a native tool-call/tool-result pair (which the mid-loop native path
 * must instead summarize as matched pairs).
 */
export function microcompactStaleToolOutputs(
  msgs: MessageForCompaction[],
  /**
   * Tool-output tokens to leave untouched, newest first. Previously a count of
   * USER TURNS (default 3), which is why this did nothing on the session that
   * prompted the change: it had two turns, so all 41,000 tokens were "recent".
   * A budget cannot be fooled by a conversation being short and enormous.
   */
  keepRecentTokens: number,
): { messages: MessageForCompaction[]; tokensDropped: number } {
  if (msgs.length === 0) return { messages: msgs, tokensDropped: 0 };

  const out = msgs.map((m) => ({ ...m }));
  let keptToolTokens = 0;
  let tokensDropped = 0;

  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== "assistant" && m.role !== "user") continue;

    const content = m.content || "";
    if (!contentLooksLikeToolResult(content)) continue;
    if (isContentProtectedForCompaction(content, m.filesWritten)) continue;
    if (isToolProtected(content)) continue;

    const t = exactTokenCountText(content);
    if (t === 0) continue;
    // Inside the recent keep-window, measured in tokens.
    if (keptToolTokens + t <= keepRecentTokens) {
      keptToolTokens += t;
      continue;
    }
    tokensDropped += t;
    out[i] = {
      ...m,
      // Neutral marker — must NOT instruct a re-read (that text literally drove
      // the re-read loop). Only genuinely-old outputs beyond the keep-window are
      // ever omitted here; recent results stay native (Stage 3b).
      content: `[Earlier tool output omitted to save space (~${t} tokens).]`,
    };
  }

  return { messages: out, tokensDropped };
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
    const hasMedia =
      m.content.includes("[image:") ||
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

/**
 * `summarizeMessages` lived here and was a near-copy of
 * `summarizeMessagesWithCompactionPrompt` below, differing only in what it LACKED:
 * no `pruneToolOutputs` pass over the head, and no `recordAuxUsage`. Those are the
 * two things you want, so the copy that had them is the one that survived and this
 * path now calls it directly. See that function for the shared behaviour.
 */

// ═══════════════════════════════════════════════════════════════
// COMPACTION RESULT TYPES
// ═══════════════════════════════════════════════════════════════

export type CompactionStrategy =
  | "none"
  | "microcompacted"
  | "pruned"
  | "stripped_media"
  | "summarized";

export interface RunSteppedCompactionResult {
  modelContext: MessageForCompaction[];
  strategy: CompactionStrategy;
  tokensFreed: number;
  summaryText?: string;
  usageRatio: number;
  compactionApplied: boolean;
  /**
   * True when the durable `[COMPACTION MARKER]` row reached the bound session, so
   * a reopened session stays compacted. False whenever `strategy !== "summarized"`
   * (nothing to persist) or when no session id could be resolved.
   */
  summaryPersisted: boolean;
  /** A summary was asked of the model and none came back (an error, or an empty answer). */
  summaryFailed?: boolean;
}

/**
 * ONE message-list counter (v14.8.11 W6): per-message exact token sum,
 * matching the context meter's scope (`computeTokenCountResult` sums
 * `estimateTokens(m.content)` per message). Every user/model-facing token
 * number for a message list must derive from this so the compress tool, the
 * auto path, and the meter agree to the token. (The old role-joined
 * `exactTokenCount` inflated counts with `role:` prefixes.)
 */
export function countMessagesTokens(
  messages: Array<{ content: string | null | undefined }>,
): number {
  return messages.reduce(
    (acc, m) => acc + exactTokenCountText(m.content || ""),
    0,
  );
}

/** Below this many history tokens a forced compaction is an honest no-op. */

// ═══════════════════════════════════════════════════════════════
// MAIN COMPACTION FUNCTION (Steps 1-5)
// ═══════════════════════════════════════════════════════════════

/** What the summariser is shown of the history, at most (about 15k tokens). */
const SUMMARY_INPUT_CHARS = 60_000;

/** The first quarter and the last three quarters of `max`, when over it. */
function headAndTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 4);
  return `${text.slice(0, head)} … ${text.slice(text.length - (max - head))}`;
}

export async function runSteppedCompaction(
  messages: MessageForCompaction[],
  tierLimit: number,
  /**
   * Currently unread. Its only consumer was `getContextSummaryForProvider`, a
   * `return null` stub deleted with the summary-chaining fix — the prior summary
   * comes out of `messages` now, not out of a per-provider store. Kept because
   * both call sites and the existing tests pass it positionally; drop it (and
   * shift `opts` up) if nothing claims it.
   */
  _providerId?: string,
  opts?: {
    /**
     * Model-initiated calls: skip the 60% usage gate (the model asked for
     * space NOW) and allow summarization below the 75% gate when the cheap
     * steps freed little — bounded by FORCE_COMPACT_MIN_HISTORY_TOKENS so a
     * tiny history returns an honest no-op instead of a degenerate summary.
     */
    force?: boolean;
    /**
     * The user asked for it (/compact): always end in a summary, as Claude Code
     * and codex do, even when pruning alone freed enough. A prune-only pass
     * writes no marker, so the next resume brought the whole history back, and
     * "/compact" read as doing nothing (QA, 2026-10-13). Implies `force`.
     */
    summarize?: boolean;
    /**
     * Tokens already spent outside the message list (system prompt + current
     * input). Added to the usage-ratio numerator so this gate sees the SAME
     * scope as the context meter — the old messages-only ratio produced
     * "meter says 70%, tool says nothing to do" disagreements.
     */
    alreadyUsedTokens?: number;
    /**
     * The chat this compaction belongs to. Two jobs, and both used to be missing
     * on this path: summarization tokens are attributed to the turn via
     * `recordAuxUsage`, and the durable `[COMPACTION MARKER]` row is persisted
     * against the chat's bound workspace session.
     *
     * Compaction on this path was BILLED TO NOBODY before v14.39.0 — the durable
     * compactor called a summarizer that took no chatId, while the two throwaway
     * compactors called one that did. The only compaction whose result survived
     * a reload was the only one whose cost never reached the meter.
     */
    chatId?: number;
    /**
     * The stream's already-resolved workspace session id. Preferred over
     * re-resolving from `chatId`, which is negative/unbound for the live
     * transport and would silently fail to persist the marker.
     */
    workspaceSessionId?: string | null;
    /** The model the conversation runs on, for the summary (else found from `chatId`). */
    model?: { provider: string; name: string };
  },
): Promise<RunSteppedCompactionResult> {
  if (messages.length === 0) {
    return {
      modelContext: messages,
      strategy: "none",
      tokensFreed: 0,
      usageRatio: 0,
      compactionApplied: false,
      summaryPersisted: false,
    };
  }

  const summarizeAsked = opts?.summarize === true;
  const force = opts?.force === true || summarizeAsked;
  const currentTokens = countMessagesTokens(messages);
  const alreadyUsed = opts?.alreadyUsedTokens ?? 0;
  // `usable` is what the caller passes: the window MINUS the reply reserve. Every
  // step below sizes itself against it, so none of them can protect more room
  // than exists. See `compactionBudgets`.
  const usable = Math.max(1, tierLimit);
  const budgets = compactionBudgets(usable);
  const usageRatio = (currentTokens + alreadyUsed) / usable;

  if (force && currentTokens < budgets.forceMinHistory) {
    return {
      modelContext: messages,
      strategy: "none",
      tokensFreed: 0,
      usageRatio,
      compactionApplied: false,
      summaryPersisted: false,
    };
  }

  if (!force && usageRatio < PRUNE_THRESHOLD) {
    return {
      modelContext: messages,
      strategy: "none",
      tokensFreed: 0,
      usageRatio,
      compactionApplied: false,
      summaryPersisted: false,
    };
  }

  let modelContext = [...messages];
  let tokensFreed = 0;
  let strategy: CompactionStrategy = "none";
  let summaryText: string | undefined;
  let summaryFailed = false;

  // Step 1.5: Microcompact — DROP stale tool outputs entirely (no LLM call).
  // Cheapest reduction; often gets us back under budget before truncation or
  // summarization is ever needed. Skipped when the user asked for a summary:
  // that is made from the conversation itself (the summariser bounds its own
  // input), not from what pruning left of it.
  if (!summarizeAsked) {
    const { messages: micro, tokensDropped } = microcompactStaleToolOutputs(
      modelContext,
      budgets.microcompactKeepTokens,
    );
    if (tokensDropped > 0) {
      modelContext = micro;
      tokensFreed += tokensDropped;
      strategy = "microcompacted";
    }
  }

  // Step 2: Prune tool outputs.
  if (!summarizeAsked && (force || usageRatio > PRUNE_THRESHOLD)) {
    const { messages: pruned, tokensPruned } = pruneToolOutputs(
      modelContext,
      budgets.pruneProtectRecent,
    );
    // ACCEPT ANY REAL REDUCTION. This used to require `tokensPruned >
    // PRUNE_MINIMUM_TOKENS` (20,000) — so on a 16,000-token budget the pruner
    // could free 15,000 tokens and have the result THROWN AWAY for not being big
    // enough. A fixed floor deciding whether work counts is the same bug as a
    // fixed floor deciding whether to do it.
    if (tokensPruned > 0) {
      modelContext = pruned;
      tokensFreed = tokensPruned;
      strategy = "pruned";
    }
  }

  // Recalculate after pruning
  const tokensAfterPrune = countMessagesTokens(modelContext);

  // Step 3: Strip media if still over budget.
  if (!summarizeAsked && tokensAfterPrune + alreadyUsed > usable) {
    const stripped = stripMediaFromMessages(modelContext);
    const strippedTokens = countMessagesTokens(stripped);
    const freedByStrip = tokensAfterPrune - strippedTokens;
    if (freedByStrip > 0) {
      modelContext = stripped;
      tokensFreed += freedByStrip;
      strategy = "stripped_media";
    }
  }

  // Recalculate after media strip
  const tokensAfterStrip = countMessagesTokens(modelContext);

  // Step 4: LLM summarization if still over the usable budget — or on a forced
  // (model-initiated) call whose cheap steps freed little: the model asked
  // for space, so give it real space instead of a token-identical no-op.
  const forcedSummarize =
    summarizeAsked ||
    (force && tokensFreed < Math.max(2_000, Math.floor(currentTokens * 0.1)));
  if (tokensAfterStrip + alreadyUsed > usable || forcedSummarize) {
    const { head: headMessages, tail_start_id: tailStartId } =
      selectMessagesForCompaction(modelContext, usable);

    // v11.1 guard: don't re-summarize a head that is just the previous
    // summary (nothing new to fold in) — avoids degenerate double passes.
    const headIsOnlyPriorSummary =
      headMessages.length === 1 && isCompactionSummaryMessage(headMessages[0]);

    // GATE ON TOKEN MASS, NOT MESSAGE COUNT.
    //
    // This used to require `headMessages.length < modelContext.length - 2`: the
    // head had to be at least two messages shorter than the whole list. With four
    // messages the head had to be exactly one; with three it was arithmetically
    // impossible. So a short-but-enormous conversation — four messages holding
    // 41,000 tokens, which is what a couple of tool-heavy turns looks like —
    // could never be summarised at any fill level. Measured 2026-08-31.
    //
    // What actually matters is whether the head holds enough to be worth a
    // provider call, which is a question about tokens.
    const headTokens = countMessagesTokens(headMessages);
    const worthSummarising =
      headTokens >= Math.min(budgets.forceMinHistory, 1_000);
    if (
      !headIsOnlyPriorSummary &&
      headMessages.length > 0 &&
      worthSummarising
    ) {
      // The generation the NEXT marker carries: one past whatever the head's
      // prior summary claims (1 when there isn't one, so the first is gen=1).
      const priorGeneration =
        extractPriorSummary(headMessages).prior?.compactionGeneration ?? 0;
      let summary = await summarizeMessagesWithCompactionPrompt({
        messages: headMessages.map((m) => ({
          role: m.role,
          content: m.content ?? "",
        })),
        chatId: opts?.chatId,
        model: opts?.model,
      });
      if (!summary) summaryFailed = true;

      // v11.1 guard: a runaway summary defeats the purpose — cap it at 25%
      // of the budget. The call's own `maxOutputTokens` (COMPACTION_MAX_OUTPUT_
      // TOKENS) is generous on purpose, so this is the real bound on length.
      if (summary) {
        const summaryTokens = exactTokenCountText(summary);
        const cap = Math.max(1_000, Math.floor(tierLimit * 0.25));
        if (summaryTokens > cap) {
          const keepChars = cap * 4; // ~4 chars/token
          summary = `${summary.slice(0, keepChars)}\n[summary truncated]`;
          logger.warn(`Compaction summary exceeded ${cap} tokens — truncated`);
        }
      }

      if (summary) {
        const summaryMsg: MessageForCompaction = {
          id: -Date.now(),
          role: "user",
          kind: COMPACTION_MARKER_KIND,
          content: `${COMPACTION_SUMMARY_PREFIX} gen=${priorGeneration + 1}\n${summary}\n${COMPACTION_SUMMARY_SUFFIX}\n${COMPACTION_RECOVERY_HINT}`,
        };

        const tailMessages = tailStartId
          ? modelContext.filter((m) => m.id >= tailStartId)
          : modelContext.slice(headMessages.length);

        modelContext = tailStartId
          ? [
              ...modelContext
                .slice(0, headMessages.length)
                .filter((m) => m.role === "system"),
              summaryMsg,
              ...tailMessages,
            ]
          : [summaryMsg, ...tailMessages];

        const newTokens = countMessagesTokens(modelContext);
        tokensFreed = tokensAfterStrip - newTokens;
        strategy = "summarized";
        summaryText = summary;

        logger.info(`Compaction summary applied: ${tokensFreed} tokens freed`);
      }
    }
  }

  // The durable write, owned here rather than by whoever called us. Only a
  // "summarized" pass produces a marker worth persisting — the cheap steps
  // (microcompact, prune, strip) leave the transcript's own messages in place,
  // so there is nothing a reload would need to be told about.
  //
  // There is deliberately NO opt-out parameter. One was written and removed
  // before it shipped: the mid-TURN path must not persist, but it does not reach
  // this function at all (it summarizes its own head so it can rebuild the
  // protected tail from native messages), so the flag had no caller. An
  // extension point with no extensions is the `profile.taskCompleteGate` shape
  // this codebase has already deleted twice. If a mid-turn caller ever does route
  // through here, add it then.
  let summaryPersisted = false;
  if (strategy === "summarized") {
    summaryPersisted = await persistCompactionSummaryToSession(
      opts?.chatId,
      modelContext,
      opts?.workspaceSessionId,
    );
  }

  return {
    modelContext,
    strategy,
    tokensFreed,
    summaryText,
    usageRatio,
    compactionApplied: strategy !== "none",
    summaryPersisted,
    ...(summaryFailed ? { summaryFailed: true } : {}),
  };
}

// ═══════════════════════════════════════════════════════════════
// FOLDED IN FROM src/lib/context-compaction.ts (v12 dedupe — the root file
// was the older v7.1.2 single-pass implementation; these are its still-used
// exports, rebased onto THIS file's exact-token internals)
// ═══════════════════════════════════════════════════════════════

/**
 * v11.1: provider "context window exceeded" error classifier — providers word
 * this differently (OpenAI `context_length_exceeded`, Anthropic "prompt is
 * too long", generic 400s with "maximum context"/"too many tokens"). Used by
 * the stream catch to force one compaction round and retry the dispatch.
 */
/** Structured provider error codes that mean "context window exceeded". */
const CONTEXT_OVERFLOW_ERROR_CODES = new Set([
  "context_length_exceeded", // OpenAI / OpenAI-compatible
  "string_above_max_length", // OpenAI long-input variant
  "model_max_prompt_tokens_exceeded",
]);

/** Pull a provider error code out of an AI-SDK APICallError-shaped error. */
function providerErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const e = error as {
    data?: { error?: { code?: unknown; type?: unknown } };
    code?: unknown;
    cause?: unknown;
  };
  const candidates = [e.data?.error?.code, e.data?.error?.type, e.code];
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  // AI SDK wraps provider errors (RetryError.cause, APICallError.cause).
  if (e.cause && e.cause !== error) return providerErrorCode(e.cause);
  return null;
}

export function isContextOverflowError(error: unknown): boolean {
  // 3.4: prefer the structured provider error code when the SDK exposes one —
  // the message regex below is wording-fragile across providers/versions.
  const code = providerErrorCode(error);
  if (code && CONTEXT_OVERFLOW_ERROR_CODES.has(code)) return true;

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  // APICallError carries the raw provider body — scan it too (some providers
  // put the useful wording only there).
  const responseBody =
    error && typeof error === "object"
      ? String((error as { responseBody?: unknown }).responseBody ?? "")
      : "";
  const haystack = `${message}\n${responseBody}`;
  if (!haystack.trim()) return false;
  return /context[_\s-]?length[_\s-]?exceeded|maximum context|context window|prompt is too long|too many tokens|maximum length|input length and `max_tokens` exceed|reduce the length of the messages|exceeds the maximum number of tokens|exceeds (?:the )?max(?:imum)? length/i.test(
    haystack,
  );
}

/**
 * Usable budget for a provider. W12 (v14.8.11): resolves through
 * `resolveModelContextLimit` (override → OpenRouter catalog → provider row →
 * models.dev → logged fallback) using the ACTIVE selected model. The old
 * `getTierContextLimitSync` alias passed a PROVIDER id where the catalog
 * expects a MODEL id, so the row never matched and every provider got the
 * hardcoded 128K fallback.
 */
/**
 * The budget a request may actually occupy: the model's window MINUS the room its
 * reply needs.
 *
 * The name was previously a lie — it returned `tierLimit`, the whole window, with
 * no output reserve at all. Everything downstream then compared against a flat
 * 0.9 to leave headroom, which on a 1M window reserved ~68,000 tokens more than
 * any reply needs and on a 16,000 cap reserved far too little for a reasoning
 * model to answer at all. The reserve is now the model's real `maxOutputTokens`
 * from models.dev, clamped so it can never swallow the window.
 */
export async function getUsableBudget(
  providerId?: string,
  /** The turn's own model (its chat's); the app's selection only when absent (15.11.1). */
  turnModel?: { provider: string; name: string },
): Promise<number> {
  const settings = readSettings();
  const selected = turnModel ?? settings.selectedModel;
  const pid = providerId ?? selected?.provider ?? "auto";
  const model =
    selected && (!providerId || selected.provider === providerId)
      ? selected
      : { provider: pid, name: selected?.name ?? "" };
  const { resolveModelContextLimit } = await import(
    "./resolve-model-context-limit"
  );
  const resolved = await resolveModelContextLimit(
    model as Parameters<typeof resolveModelContextLimit>[0],
    settings,
  );
  return resolveUsableBudget(
    model as Parameters<typeof resolveModelContextLimit>[0],
    resolved.tierLimit,
  );
}

/**
 * Shared by every caller that needs "how much room do I actually have": resolve
 * the model's output limit from the catalog and subtract it from the window.
 * Falls back to the window itself if the catalog lookup throws — a missing
 * reserve is better than a failed turn.
 */
export async function resolveUsableBudget(
  model: { provider?: string; name?: string },
  contextWindow: number,
): Promise<number> {
  try {
    const { getMaxTokensWithFloor } = await import("@/ipc/utils/token_utils");
    const maxOutputTokens = await getMaxTokensWithFloor(
      model as Parameters<typeof getMaxTokensWithFloor>[0],
    );
    return usableContextBudget({ contextWindow, maxOutputTokens });
  } catch (e) {
    logger.warn(
      "[compaction] could not resolve output reserve — using the full window",
      e,
    );
    return contextWindow;
  }
}

/**
 * Tool-output token budget kept verbatim at the tail of the transcript before
 * compaction summarization.
 */
const HEAD_TOOL_TOKENS = 40_000;

/**
 * Output cap for the compaction summary call.
 *
 * This was `maxTokens: 1500` behind an `as` cast — and ai 7 has no `maxTokens`
 * (it is `maxOutputTokens`), so the call had NO cap at all while its comment
 * claimed one. 1,500 would also be wrong now: a reasoning model spends part of
 * any cap thinking, and a summary that comes back empty loses the whole head
 * of the conversation. So the cap is generous — runaway insurance — and the
 * 25%-of-budget truncation after the call bounds the summary itself.
 */
const COMPACTION_MAX_OUTPUT_TOKENS = 8_000;

/**
 * Same summarization path as runSteppedCompaction's step 4 (CONTEXT_COMPACTION_*
 * + summarization model), no DB writes. Used for pre-dispatch tier context
 * budgeting (tier_context_budget.ts).
 */
export async function summarizeMessagesWithCompactionPrompt(params: {
  messages: { role: string; content: string }[];
  sessionStats?: { toolCallCount?: number; delegationCount?: number };
  priorSummary?: {
    summaryText: string;
    compactionGeneration: number;
  } | null;
  /** v10: when set, summarization tokens count toward this chat's turn usage. */
  chatId?: number;
  /** The turn's model, when the caller knows it; else found from `chatId` (summarization_model.ts). */
  model?: { provider: string; name: string };
}): Promise<string | null> {
  const { messages } = params;
  if (messages.length === 0) return null;

  // Same reason as `summarizeMessages`: lift the previous summary out of the
  // transcript so it is handed over as a labelled prior summary rather than
  // truncated inline. An explicit `priorSummary` param still wins when a caller
  // supplies one.
  const { prior, rest } = extractPriorSummary(messages);
  const priorSummary = params.priorSummary ?? prior;
  if (rest.length === 0) return null;

  // Reuse this file's pruner (needs ids; synthesize ordinals).
  const { messages: forSummary } = pruneToolOutputs(
    rest.map((m, i) => ({ id: i, role: m.role, content: m.content || "" })),
    HEAD_TOOL_TOKENS,
  );

  // Each message within a share of one budget, keeping its START and, mostly,
  // its END: an assistant turn ends with its answer. The old flat 2,000-char
  // head cut turned one long explore turn into "I'll start by reading…" and
  // lost the answer entirely (QA, 2026-10-13: a 96k-token turn summarised to
  // ~250 tokens).
  const perMessage = Math.max(
    2_000,
    Math.floor(SUMMARY_INPUT_CHARS / Math.max(1, forSummary.length)),
  );
  const formatted = forSummary
    .map(
      (m) =>
        `${m.role === "user" ? "User" : "Assistant"}: ${headAndTail(
          (m.content || "").replace(/\n/g, " "),
          perMessage,
        )}`,
    )
    .join("\n\n");

  const userPrompt =
    buildCompactionUserPromptPrefix(priorSummary ?? undefined) + formatted;

  try {
    const settings = readSettings();
    const summarizationModel = await getCompactionSummarizationModel(
      settings,
      params.model ?? (await turnModelForChat(params.chatId, settings)),
    );
    const { modelClient } = await getModelClient(summarizationModel, settings, {
      purpose: "compaction",
      ...(params.chatId != null ? { sessionChatId: params.chatId } : {}),
    });

    const result = await generateText({
      model: modelClient.model,
      system: CONTEXT_COMPACTION_SYSTEM,
      messages: [{ role: "user" as const, content: userPrompt }],
      maxOutputTokens: COMPACTION_MAX_OUTPUT_TOKENS,
    });
    recordAuxUsage(params.chatId, result.usage, "compaction");

    const summaryText = result.text.trim();
    return summaryText || null;
  } catch (error) {
    logger.error("summarizeMessagesWithCompactionPrompt failed:", error);
    return null;
  }
}
