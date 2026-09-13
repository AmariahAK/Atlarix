/**
 * Compaction: keeping a long conversation inside the model's context window.
 *
 * CHEAPEST FIRST, and each step re-measures before the next one runs. Most
 * conversations that cross the line are tool-heavy rather than long, and the
 * first two steps need no model call at all:
 *
 *   1. `microcompactStaleToolOutputs` — replace stale tool results with a
 *      marker. No model call. Frees the most tokens for nothing.
 *   2. `pruneToolOutputs` — clip what is left to 2,000 characters, keeping the
 *      head so a result is still recognisable. No model call.
 *   3. Summarise the head into a durable `[COMPACTION MARKER]`. One model call,
 *      and only when the first two were not enough.
 *
 * THE ORDER IS THE DESKTOP'S, and it is confirmed by what the market does.
 * Checked 2026-09-13: OpenCode prunes old tool outputs before summarising;
 * Claude Code and Codex CLI summarise directly with no cheaper step. Tool
 * results are the bulk in an agentic session and they are REGENERABLE — the page
 * can be read again — so spending a model call to compress them before trying to
 * drop them is paying for the expensive answer first.
 *
 * WHAT WE DO THAT THE MARKET DOES NOT. None of Claude Code, Codex CLI, OpenCode
 * or Amp tells the model that the detail behind a summary is still retrievable,
 * or gives it a tool to go and get it. A model handed a summary reasonably
 * assumes the rest is gone, and fills the hole by guessing or by asking the user
 * to repeat themselves. Every marker this module writes carries the recovery
 * hint, and §5's `recall` tool is what makes the hint true.
 *
 * THE SHAPE HERE IS SAFER THAN THE DESKTOP'S, AND STRICTER.
 *
 * Safer: a tool result is its own `role: "tool"` message, so identifying one is
 * `m.role === "tool"` rather than the desktop's regex over embedded text. There
 * is nothing to misclassify.
 *
 * Stricter: the OpenAI wire format REQUIRES that every assistant `tool_calls`
 * entry is answered by a `tool` message with the matching id, and that no `tool`
 * message appears without its call. So a `tool` message may have its CONTENT
 * replaced but must never be removed, and the kept tail may never begin in the
 * middle of a tool exchange. A provider answers either mistake with a 400 that
 * names neither cause.
 */

import type { CoreMessage } from "../core/client";
import {
  compactionBudgets,
  estimateMessages,
  estimateTokens,
} from "./budget";
import { COMPACTION_SYSTEM, buildCompactionUserPrompt } from "./prompt";

/** Opens a durable summary. Matched with `startsWith` so `gen=N` can follow. */
export const COMPACTION_MARKER_PREFIX = "[COMPACTION MARKER]";
/** Closes the summary body. Everything after it is addressed to the model. */
export const COMPACTION_MARKER_SUFFIX = "[END COMPACTION]";

/**
 * What every summary says about the turns behind it.
 *
 * WITHOUT THIS THE `recall` TOOL EXISTS AND GOES UNUSED. A model reading a
 * summary has no way to know the original turns are still on this device and
 * searchable; assuming they are gone is the honest reading of what a summary
 * looks like. So it guesses, or it asks the user to repeat something the user
 * already said.
 *
 * Deliberately placed AFTER the suffix. `extractPriorSummary` cuts the body at
 * the last suffix occurrence, so this line reaches the model on every round but
 * is never folded into the next generation's summary as though it were
 * something the user said.
 */
export const COMPACTION_RECOVERY_HINT =
  "The detail behind this summary is not lost — the full earlier conversation is still stored on this device. " +
  "Use `recall` to retrieve a specific fact (an exact figure, a URL, something the user said) rather than guessing " +
  "or asking the user to repeat it. Do not use it to re-read the conversation wholesale.";

/**
 * How much of a clipped tool result survives, in characters.
 *
 * Enough that the result is still identifiable — a page title, the first rows of
 * a table — and not enough to be worth reasoning from. The marker above it says
 * outright that it was clipped, because a truncated result with no marker is
 * worse than no result at all: the model reads half a page as the whole page.
 */
export const TOOL_OUTPUT_MAX_CHARS = 2_000;

/**
 * Is this the durable summary row?
 *
 * A TYPE PREDICATE, so a caller that has identified a marker also has its
 * `content` as a string. Without it every render site needs a second null check
 * on a field the check above already proved.
 */
export function isCompactionMarker(
  m: CoreMessage,
): m is { role: "user"; content: string } {
  return (
    m.role === "user" &&
    typeof m.content === "string" &&
    m.content.startsWith(COMPACTION_MARKER_PREFIX)
  );
}

const GENERATION_RE = new RegExp(
  `^${COMPACTION_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*gen=(\\d+)`,
);

export interface PriorSummary {
  summaryText: string;
  /** 1 for the first pass. A legacy marker with no `gen=` reads as 1. */
  generation: number;
}

/**
 * Pull the previous summary out of a transcript, returning it separately.
 *
 * The caller hands it to the prompt builder as a labelled prior; `rest` is what
 * gets summarised. Leaving it inline would let it be flattened and truncated
 * like any other message — see `prompt.ts` for why that degrades across
 * generations.
 */
export function extractPriorSummary(messages: CoreMessage[]): {
  prior: PriorSummary | null;
  rest: CoreMessage[];
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isCompactionMarker(m)) continue;
    const content = m.content as string;

    const generation = Number(GENERATION_RE.exec(content)?.[1] ?? 1);
    let body = content.slice(COMPACTION_MARKER_PREFIX.length);
    body = body.replace(/^\s*gen=\d+/, "").replace(/^\r?\n/, "");
    const end = body.lastIndexOf(COMPACTION_MARKER_SUFFIX);
    if (end !== -1) body = body.slice(0, end);

    const summaryText = body.trim();
    if (!summaryText) return { prior: null, rest: messages };
    return {
      prior: {
        summaryText,
        generation: Number.isFinite(generation) && generation > 0 ? generation : 1,
      },
      rest: [...messages.slice(0, i), ...messages.slice(i + 1)],
    };
  }
  return { prior: null, rest: messages };
}

/** Write the durable marker row for generation `generation`. */
export function compactionMarker(
  summary: string,
  generation: number,
): CoreMessage {
  return {
    role: "user",
    content:
      `${COMPACTION_MARKER_PREFIX} gen=${generation}\n${summary.trim()}\n` +
      `${COMPACTION_MARKER_SUFFIX}\n${COMPACTION_RECOVERY_HINT}`,
  };
}

/* ── Step 1: microcompact ─────────────────────────────────────────────────── */

/**
 * Replace stale tool results with a one-line marker. No model call.
 *
 * A TOKEN BUDGET, NOT A TURN COUNT. The desktop's version kept "the last 3
 * turns", and the measured session that prompted the change had two turns and
 * 41,000 tokens — so everything was "recent" and this did nothing at all. A
 * budget cannot be fooled by a conversation that is short and enormous.
 *
 * THE CONTENT IS REPLACED, THE MESSAGE IS NOT REMOVED. A `tool` message whose
 * assistant `tool_calls` entry still exists is not optional — deleting it makes
 * the next request malformed.
 *
 * The marker does NOT tell the model to read the page again. That exact wording
 * drove a re-read loop on the desktop: the model saw an instruction, obeyed it,
 * produced a fresh result, and the next compaction dropped that one too. It
 * points at `recall` instead, which is a different thing entirely — the archive
 * holds an excerpt of this very result, so looking there costs nothing and
 * cannot start the loop.
 */
export function microcompactStaleToolOutputs(
  messages: CoreMessage[],
  keepRecentTokens: number,
): { messages: CoreMessage[]; tokensDropped: number } {
  if (messages.length === 0) return { messages, tokensDropped: 0 };

  const out = [...messages];
  let kept = 0;
  let tokensDropped = 0;

  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== "tool") continue;
    const tokens = estimateTokens(m.content);
    if (tokens === 0) continue;
    if (kept + tokens <= keepRecentTokens) {
      kept += tokens;
      continue;
    }
    tokensDropped += tokens;
    out[i] = {
      ...m,
      content:
        `[Earlier tool output omitted to save space (~${tokens} tokens). ` +
        `An excerpt is searchable with \`recall\`.]`,
    };
  }

  return { messages: out, tokensDropped };
}

/* ── Step 2: prune ────────────────────────────────────────────────────────── */

/**
 * Clip tool results past the protected budget to their first 2,000 characters.
 *
 * Runs after microcompact and catches what microcompact protected but is still
 * too much — the same newest-first walk against a smaller budget.
 *
 * NOT `Math.max(20_000, …)`. A fixed floor protected more tool output than a
 * small window contains, so on a 16,000-token budget a 19,000-token message was
 * kept whole and this freed nothing. The caller passes a budget-derived number;
 * a protection floor may never exceed the budget it protects space within.
 */
export function pruneToolOutputs(
  messages: CoreMessage[],
  protectRecentTokens: number,
): { messages: CoreMessage[]; tokensPruned: number } {
  if (messages.length === 0) return { messages, tokensPruned: 0 };

  const out = [...messages];
  let kept = 0;
  let tokensPruned = 0;

  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== "tool") continue;
    if (m.content.startsWith("[Earlier tool output omitted")) continue;
    const tokens = estimateTokens(m.content);
    if (kept + tokens <= protectRecentTokens) {
      kept += tokens;
      continue;
    }
    if (m.content.length <= TOOL_OUTPUT_MAX_CHARS) continue;

    const head = m.content.slice(0, TOOL_OUTPUT_MAX_CHARS);
    const clipped = `[Earlier tool output clipped (~${tokens} tokens). Use \`recall\` if you need what is missing.]\n\n${head}`;
    tokensPruned += tokens - estimateTokens(clipped);
    out[i] = { ...m, content: clipped };
  }

  return { messages: out, tokensPruned };
}

/* ── Step 3: choosing what to summarise ───────────────────────────────────── */

/**
 * Where the protected tail may begin.
 *
 * NOT A `tool` MESSAGE, EVER. A tail starting there is a tool result whose
 * assistant call is on the other side of the summary — the exact malformed
 * request the OpenAI format rejects, and the 400 it comes back with names
 * neither the message nor the reason.
 *
 * An assistant message IS a valid start: its own tool results follow it, so the
 * pair stays whole.
 */
function canStartTail(m: CoreMessage | undefined): boolean {
  return m !== undefined && m.role !== "tool";
}

interface TurnSpan {
  start: number;
  end: number;
}

/** Turn boundaries: a turn runs from a user message to just before the next. */
function turnSpans(messages: CoreMessage[]): TurnSpan[] {
  const spans: TurnSpan[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") {
      spans.push({ start: i, end: messages.length });
    }
  }
  for (let i = 0; i < spans.length - 1; i++) spans[i].end = spans[i + 1].start;
  return spans;
}

/**
 * The largest suffix of one turn that fits `budget`, or undefined.
 *
 * Only offers a start the wire format allows — see `canStartTail`.
 */
function splitTurn(
  messages: CoreMessage[],
  span: TurnSpan,
  budget: number,
): number | undefined {
  if (budget <= 0 || span.end - span.start <= 1) return undefined;
  for (let start = span.start + 1; start < span.end; start++) {
    if (!canStartTail(messages[start])) continue;
    if (estimateMessages(messages.slice(start, span.end)) <= budget) {
      return start;
    }
  }
  return undefined;
}

/**
 * Split the history into a HEAD to summarise and a TAIL to keep verbatim.
 *
 * PROTECTION IS A TOKEN BUDGET, NOT A TURN COUNT — and the market agrees: Codex
 * CLI protects "recent user messages up to 20k tokens", OpenCode protects a
 * token budget of recent tool output. A rule counting turns cannot tell 200
 * tokens from 40,000.
 *
 * WHEN EVEN THE NEWEST TURN WILL NOT FIT, PROTECT LESS RATHER THAN ABANDON. The
 * desktop's earlier version protected nothing in that case, which made the head
 * the entire conversation and let the caller refuse — so a message was
 * untouchable purely because it was recent, at any fill level. Here an oversized
 * recent turn falls into the head and is summarised like any other history.
 *
 * The last user message is always protected, however small. A tail of nothing
 * means summarising the request the model is in the middle of answering.
 */
export function selectMessagesForCompaction(
  messages: CoreMessage[],
  usable: number,
): { head: CoreMessage[]; tail: CoreMessage[] } {
  const budget = compactionBudgets(usable).preserveRecent;
  const spans = turnSpans(messages);
  // No user message means no turn boundary, and therefore no safe place to cut.
  if (spans.length === 0) return { head: [], tail: messages };

  let total = 0;
  let keepFrom: number | undefined;

  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    const size = estimateMessages(messages.slice(span.start, span.end));
    if (total + size <= budget) {
      total += size;
      keepFrom = span.start;
      continue;
    }
    const split = splitTurn(messages, span, budget - total);
    if (split !== undefined) keepFrom = split;
    break;
  }

  if (keepFrom === undefined) {
    const lastTurn = spans[spans.length - 1];
    if (lastTurn.start > 0) keepFrom = lastTurn.start;
  }

  // NOTHING TO CUT IS AN EMPTY HEAD, NOT A FULL ONE — and the difference is the
  // whole conversation. `keepFrom === 0` means the protection budget covered
  // every turn there is; the desktop's version returned the entire history as
  // the head there, which reads to a caller as "summarise all of it and keep
  // nothing". The orchestrator's `forceMinHistory` guard makes that state
  // unreachable today, but a contract that is only safe because of a check
  // somewhere else is a contract waiting to be called from somewhere new.
  if (keepFrom === undefined || keepFrom <= 0) {
    return { head: [], tail: messages };
  }
  return {
    head: messages.slice(0, keepFrom),
    tail: messages.slice(keepFrom),
  };
}

/* ── Rendering the head for the summariser ────────────────────────────────── */

/**
 * Flatten the head into one block of text.
 *
 * FLATTENED RATHER THAN FORWARDED AS MESSAGES, because the summariser is an
 * ordinary Core call: handing it a half-conversation would mean carrying matched
 * `tool_calls`/`tool` pairs into a request that is not continuing that
 * conversation at all. As text, a tool call is just a line.
 */
export function renderForSummary(messages: CoreMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      lines.push(`tool result: ${m.content}`);
      continue;
    }
    if (m.role === "assistant") {
      if (m.content) lines.push(`assistant: ${m.content}`);
      for (const call of m.tool_calls ?? []) {
        lines.push(
          `assistant called ${call.function.name}(${call.function.arguments})`,
        );
      }
      continue;
    }
    lines.push(`user: ${m.content}`);
  }
  return lines.join("\n\n");
}

/* ── The orchestrator ─────────────────────────────────────────────────────── */

/** One model call, supplied by the caller so this module stays testable. */
export type Summarise = (
  messages: CoreMessage[],
  signal?: AbortSignal,
) => Promise<string>;

export interface CompactionResult {
  messages: CoreMessage[];
  /** True when anything at all changed. */
  changed: boolean;
  /** Which steps actually ran, newest last. For the status line. */
  steps: string[];
  beforeTokens: number;
  afterTokens: number;
  /** True when the model was called. False means the cheap steps were enough. */
  summarised: boolean;
}

/**
 * Bring a conversation back inside `usable`, doing as little as possible.
 *
 * RETURNS THE BEST IT MANAGED, NEVER AN ERROR. A summariser call that fails must
 * not lose the conversation and must not abort the user's turn — the two cheap
 * steps have usually already freed most of what was needed, and a slightly
 * oversized request that the provider might still accept beats a turn that ends
 * in an apology. The failure is reported through `summarised`, not thrown.
 */
export async function compactConversation(params: {
  messages: CoreMessage[];
  overheadTokens: number;
  usable: number;
  summarise: Summarise;
  signal?: AbortSignal;
}): Promise<CompactionResult> {
  const { overheadTokens, usable } = params;
  const budgets = compactionBudgets(usable);
  const beforeTokens = estimateMessages(params.messages) + overheadTokens;
  const steps: string[] = [];

  const fits = (messages: CoreMessage[]) =>
    estimateMessages(messages) + overheadTokens <= usable;

  const done = (messages: CoreMessage[], summarised: boolean) => ({
    messages,
    changed: messages !== params.messages,
    steps,
    beforeTokens,
    afterTokens: estimateMessages(messages) + overheadTokens,
    summarised,
  });

  if (fits(params.messages)) return done(params.messages, false);

  // 1. Stale tool output. No model call.
  let working = params.messages;
  const micro = microcompactStaleToolOutputs(
    working,
    budgets.microcompactKeepTokens,
  );
  if (micro.tokensDropped > 0) {
    working = micro.messages;
    steps.push(`dropped ~${micro.tokensDropped} tokens of old page reads`);
    if (fits(working)) return done(working, false);
  }

  // 2. Clip what is left. Still no model call.
  const pruned = pruneToolOutputs(working, budgets.pruneProtectRecent);
  if (pruned.tokensPruned > 0) {
    working = pruned.messages;
    steps.push(`clipped ~${pruned.tokensPruned} tokens of tool results`);
    if (fits(working)) return done(working, false);
  }

  // 3. Summarise. Only now is a model call worth its cost.
  //
  // Below this much history a summary cannot free enough to pay for the round
  // trip, and the honest answer is to send the oversized request and let the
  // provider decide. Compacting a conversation that is mostly system prompt just
  // deletes the user's words for nothing.
  if (estimateMessages(working) < budgets.forceMinHistory) {
    return done(working, false);
  }

  const { prior, rest } = extractPriorSummary(working);
  const { head, tail } = selectMessagesForCompaction(rest, usable);
  if (head.length === 0) return done(working, false);

  // The head goes to the summariser with its own tool budget — a head that is
  // 90% page text produces a summary of page text.
  const headForSummary = pruneToolOutputs(head, budgets.headToolTokens).messages;

  try {
    const summary = (
      await params.summarise(
        [
          { role: "system", content: COMPACTION_SYSTEM },
          {
            role: "user",
            content: buildCompactionUserPrompt(
              renderForSummary(headForSummary),
              prior,
            ),
          },
        ],
        params.signal,
      )
    ).trim();
    if (!summary) return done(working, false);

    const generation = (prior?.generation ?? 0) + 1;
    steps.push(`summarised ${head.length} earlier messages`);
    return done([compactionMarker(summary, generation), ...tail], true);
  } catch {
    // The cheap steps already ran and their result is real. Losing it because
    // the summariser was unreachable would turn one recoverable failure into
    // two.
    return done(working, false);
  }
}

/** What the transcript looks like once a marker is in it, for the panel. */
export function markerBody(content: string): string {
  let body = content.slice(COMPACTION_MARKER_PREFIX.length);
  body = body.replace(/^\s*gen=\d+/, "").replace(/^\r?\n/, "");
  const end = body.lastIndexOf(COMPACTION_MARKER_SUFFIX);
  return (end === -1 ? body : body.slice(0, end)).trim();
}

/** The generation on a marker row, for the panel's label. */
export function markerGeneration(content: string): number {
  const n = Number(GENERATION_RE.exec(content)?.[1] ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
