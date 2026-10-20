/**
 * StreamTurnContext — the per-turn mutable state of `runStream`, formalized
 * from the bare `let`/`const` locals so the turn-runner closures can be
 * extracted into free functions that take `(ctx, …)`. Flat fields named exactly
 * as the original locals (mechanical `x` → `ctx.x` migration; tsc is the
 * checklist).
 *
 * Scope: this holds ONLY the Group-A accumulators/flags that are mutated across
 * the ask/build branches, the shared streaming callbacks, and finalization.
 * Read-only-after-init config (settings, appPath, models, …) is passed to
 * extracted functions as params; the compaction assembly working set
 * (systemPrompt, budgetTracker, …) is threaded separately. Already-shared
 * module state (partialResponses, activeStreams, …) lives in ./stream-state.
 *
 * (Satellite: never imports the parent handler.)
 */

import type { UserInterjection } from "@/lib/agent/user-interjections";
import type { ModelMessage } from "ai";

export interface StreamTurnContext {
  // ── accumulators ────────────────────────────────────────────────────────
  /** Accumulated assistant text for the turn (read at finalization). */
  fullResponse: string;
  /** Native provider tool/message parts accumulated across rounds; serialized at finalization. */
  nativeTurnMessages: ModelMessage[];
  /** Workspace-relative paths written this exchange (build); drives snapshots. */
  filesWrittenInThisExchange: string[];

  // ── per-turn usage tallies (mutated in the shared onStepFinish/onFinish) ──
  turnInputTokens: number;
  turnOutputTokens: number;
  turnCachedInputTokens: number;
  turnCacheCreationTokens: number;
  turnActualCostUsd: number;
  maxTokensUsed: number | undefined;
  maxReasoningTokensUsed: number | undefined;

  // ── control flags (gate finalization / terminal payload) ─────────────────
  /** Turn ended via end-turn ask_user (clean completion despite an aborted controller). */
  askUserEndedTurn: boolean;
  /** Turn ended via the forced tools-off finish round (controller left aborted). */
  turnForcedTextFinish: boolean;
  /** runAgentTurn ended with background work outstanding (turn over, not held). */
  turnParked: boolean;
  /** Guards the single terminal emit (ensureTerminal). */
  streamTerminated: boolean;
  /** Build turn ran tools or hit permission prompts. */
  hadToolCallsOrPermissions: boolean;
  /** Set by the orchestrator wiring; invoked in finally. */
  stopAgentOrchestrator: (() => void) | undefined;
  /** Dedup memo for tool-input progress activity. */
  lastToolInputPhaseLabel: string;
  /** Take-once empty-output nudge: the retry wrapper sets it, simpleStreamText's
   * prepareStep reads-and-clears it (shared across those two extracted fns). */
  pendingEmptyOutputNudge: string | null;
  /**
   * Mid-turn messages the latest step took, and those a retry must hand to the
   * next attempt. A request that failed (no connection) took them and was
   * retried without them: the model never saw what you said (QA). Same split:
   * prepareStep sets `delivered` and reads `carried`; round-retry moves one to
   * the other when it retries.
   */
  deliveredInterjections: UserInterjection[] | null;
  carriedInterjections: UserInterjection[] | null;
  /**
   * Sticky for the rest of the turn once a provider rejects a forced tool_choice
   * (same set/read split as `pendingEmptyOutputNudge`: round-retry sets it,
   * simpleStreamText reads it).
   *
   * The capability gate on `forceCollectOnWake` should keep us off that path, but
   * it depends on a catalog row being present and correct. This is the backstop:
   * a provider we have not met rejecting the forced choice must cost one retry,
   * not the turn. Sticky rather than per-attempt because the rejection is a fact
   * about this model, not a transient.
   */
  forcedToolChoiceRejected: boolean;

  // ── delegation (sub-agent) bookkeeping ───────────────────────────────────
  delegatedAgentsThisTurn: string[];
  delegationsStartedThisTurn: number;
  inFlightDelegationKeys: Set<string>;

  // ── analytics: what `turn_completed` reports, set as the turn learns it ──
  analyticsTurn: {
    mode?: string;
    provider?: string;
    model?: string;
    effort?: string;
    fellBackToCore?: boolean;
    hadHistory?: boolean;
  };
}

/** Fresh per-turn context with the same initial values the bare locals had. */
export function createStreamTurnContext(): StreamTurnContext {
  return {
    fullResponse: "",
    nativeTurnMessages: [],
    filesWrittenInThisExchange: [],
    turnInputTokens: 0,
    turnOutputTokens: 0,
    turnCachedInputTokens: 0,
    turnCacheCreationTokens: 0,
    turnActualCostUsd: 0,
    maxTokensUsed: undefined,
    maxReasoningTokensUsed: undefined,
    askUserEndedTurn: false,
    turnForcedTextFinish: false,
    turnParked: false,
    streamTerminated: false,
    hadToolCallsOrPermissions: false,
    stopAgentOrchestrator: undefined,
    lastToolInputPhaseLabel: "",
    pendingEmptyOutputNudge: null,
    deliveredInterjections: null,
    carriedInterjections: null,
    forcedToolChoiceRejected: false,
    delegatedAgentsThisTurn: [],
    delegationsStartedThisTurn: 0,
    inFlightDelegationKeys: new Set<string>(),
    analyticsTurn: {},
  };
}
