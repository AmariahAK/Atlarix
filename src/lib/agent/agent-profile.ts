/**
 * v12 0.1 — AgentProfile: the per-mode parameterization of the unified
 * agent-turn engine (run-agent-turn.ts).
 *
 * The engine owns CONTROL FLOW only (round dispatch, break decisions, native
 * fold, compaction, escalation). Everything mode-specific arrives here as
 * data flags or injected capabilities built in chat_stream_handlers.ts —
 * deliberately closures over the handler scope, because 0.1 extracts the
 * loop, not the state (state extraction is 0.4).
 *
 * Exactly TWO profiles exist, built inline at the handler call sites:
 * build (agentic multi-round) and ask (singleRound). Do not add a third
 * without a mode that actually exists.
 */

import type { ToolSet } from "ai";
import type { AgenticRepetitionState } from "@/lib/streaming/agentic-loop-repetition";

export interface TextToolCallLike {
  toolName: string;
  args: unknown;
}

export interface TextToolExecOutcome {
  /** Per-tool results, already stringified for the synthetic feedback message. */
  iterationResults: Array<{ tool: string; result: string }>;
  /** True when any executed tool buffered a permission request. */
  hasPermissionRequest: boolean;
}

/**
 * A round's system prompt, when the mode splits it (ask: stable header for
 * the prompt cache + dynamic tail appended as a separate system block).
 */
export interface RoundSystemPrompt {
  systemPromptOverride: string;
  dynamicSystemTail?: string;
}

export interface AgentProfile {
  readonly mode: "ask" | "build";
  /** Log prefix — keeps engine logs grep-compatible with the legacy loops. */
  readonly loopLogLabel: string;
  /** runMidLoopCompaction loopLabel. */
  readonly compactionLabel: string;
  /**
   * Prose-only round policy:
   * - number (build: 5): nudge the model and continue, break at the cap;
   * - undefined (ask): a prose round simply ENDS the turn (the ask loop's
   *   historical "model stopped = turn over" semantics).
   */
  readonly proseOnlyStreakMax?: number;
  /** Static escalation mode label (computed from workMode at profile build). */
  readonly escalationMode: "ask" | "plan" | "build" | "agent";
  /**
   * Ask semantics: a COMPLETED round ends the turn, tools or not — the
   * AI-SDK inner loop already did the multi-step tool work, and the engine's
   * outer loop exists only for the in-round truncation continuations. The
   * engine breaks after the first completed round (capturing the round's
   * native messages for the B2 turn envelope — ask inherits native history
   * here) and never emits iteration progress. Build leaves this unset.
   */
  readonly singleRound?: boolean;

  /** Pre-built ToolSet for this turn (the wrappers close over handler state). */
  readonly tools: ToolSet;
  /** The SAME repetition-state instance the tool wrappers record into. */
  readonly repetition: AgenticRepetitionState;

  /**
   * Prompt injected for the forced tools-off finish round (repetition escalation
   * or round-cap). Defaults to a shared summarize-and-stop instruction when a
   * profile doesn't override it. Provider-agnostic plain text.
   */
  buildForceFinishPrompt?(): string;

  /**
   * Per-iteration system prompt (progressive-reveal manifest refresh). A
   * RoundSystemPrompt keeps the stable header and the dynamic tail separate
   * system blocks for the prompt cache: ask builds one per round (async: it
   * re-resolves the context window), build splits its joined prompt.
   */
  buildRoundSystemPrompt(): string | RoundSystemPrompt | Promise<string | RoundSystemPrompt>;

  /**
   * Text-tool fallback surface (weak/local models emitting XML tool calls).
   * All three are unset for ask (native-only). `detectTextToolCalls` returns
   * the parsed calls when the round's text contains any, else null.
   */
  detectTextToolCalls?(fullResponse: string): TextToolCallLike[] | null;
  executeTextToolCalls?(
    calls: TextToolCallLike[],
  ): Promise<TextToolExecOutcome>;
  stripTextToolXML?(text: string): string;

  /**
   * `stop` hooks — the person's hooks.json and installed plugins', never a
   * workspace's (lib/plugins/hooks.ts). Runs FIRST when a build/debug turn would
   * end; a non-null feedback string keeps the turn going (bounded by the red-gate
   * cap) and is fed back to the model. Supplied only when such a hook exists.
   */
  taskCompleteGate?(): Promise<string | null>;
}
