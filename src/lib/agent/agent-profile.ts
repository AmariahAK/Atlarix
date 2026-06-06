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
 * Exactly TWO profiles exist: build (buildBuildProfile) and ask
 * (buildAskProfile, lands with the ask migration). Do not add a third
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

export interface AgentProfile {
  readonly mode: "ask" | "build";
  /** Log prefix — keeps engine logs grep-compatible with the legacy loops. */
  readonly loopLogLabel: string;
  /** runMidLoopCompaction loopLabel. */
  readonly compactionLabel: string;
  /** Honor <task_complete> + completed-ledger breaks (build). Ask ignores them. */
  readonly honorTaskCompleteBreak: boolean;
  /**
   * Prose-only round policy:
   * - number (build: 5): nudge the model and continue, break at the cap;
   * - undefined (ask): a prose round simply ENDS the turn (the ask loop's
   *   historical "model stopped = turn over" semantics).
   */
  readonly proseOnlyStreakMax?: number;
  /** Static escalation mode label (computed from workMode at profile build). */
  readonly escalationMode: "ask" | "plan" | "build" | "agent";

  /** Pre-built ToolSet for this turn (the wrappers close over handler state). */
  readonly tools: ToolSet;
  /** The SAME repetition-state instance the tool wrappers record into. */
  readonly repetition: AgenticRepetitionState;

  /** Per-iteration system prompt (progressive-reveal manifest refresh). */
  buildRoundSystemPrompt(): string;

  /**
   * Text-tool fallback surface (weak/local models emitting XML tool calls).
   * All three are unset for ask (native-only). `detectTextToolCalls` returns
   * the parsed calls when the round's text contains any, else null.
   */
  detectTextToolCalls?(fullResponse: string): TextToolCallLike[] | null;
  executeTextToolCalls?(calls: TextToolCallLike[]): Promise<TextToolExecOutcome>;
  stripTextToolXML?(text: string): string;

  /**
   * 0.3/1.2 seam (UNSET in 0.1): post-write verification — run LSP
   * diagnostics on touched files and feed errors back into the loop.
   */
  postWriteVerify?(writtenPaths: string[]): Promise<void>;
}
