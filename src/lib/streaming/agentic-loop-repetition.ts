/**
 * Doom-loop detector — staged: guide, guide harder, only then circuit-break
 * (v14.8.10; supersedes the trip-once force-finish of the Stage-5 version).
 *
 * Detection is still opencode's doom-loop net (packages/opencode `processor`
 * DOOM_LOOP_THRESHOLD = 3): the SAME tool with BYTE-IDENTICAL input, counted
 * consecutively. What changed is the RESPONSE. Observed live: force-finishing
 * on the first trip cut a legitimately-recoverable turn dead — the goal is
 * guidance that finishes the task; stopping is the model's choice. So:
 *
 *   3 identical  → `loop_correct` attempt 1 — the caller returns a corrective
 *                  TOOL RESULT instead of executing (steer: re-read / change
 *                  approach). No abort; the SDK loop continues.
 *   6 identical  → `loop_correct` attempt 2 — stronger steer + an explicit
 *                  invitation to mark the step blocked / end the turn with a
 *                  status report (the model's own stop).
 *   9 identical  → `loop_abort` — the model ignored the same feedback twice;
 *                  the caller fires the tools-off FORCE_TEXT_FINISH backstop.
 *
 * The consecutive count keeps accumulating across correction trips (it only
 * resets when a DIFFERENT call arrives), so deafness escalates deterministically.
 *
 * The interface name is kept (`AgenticRepetitionState`) so the engine wiring and
 * `AgentProfile.repetition` need no change; `takePendingCorrection`/
 * `consumeLoopBreak` are inert stubs retained for that compatibility.
 */

/** Identical-call count at which each stage fires. */
const CORRECT_1_THRESHOLD = 3;
const CORRECT_2_THRESHOLD = 6;
const ABORT_THRESHOLD = 9;

/**
 * v14.8.7 §A5 (minimal band-aid): the tool guard above is byte-identical-CALL
 * only. A separate observed failure is repeated assistant TEXT — a model that
 * re-emits the SAME "4 done, 1 remains" status table each round while its tool
 * calls vary slightly (so the tool guard never trips). The live ledger (§A1)
 * removes most of the need, so this is deliberately conservative: a HIGH
 * consecutive threshold and only counts SUBSTANTIAL status-like text.
 */
const TEXT_REPETITION_THRESHOLD = 3;
const MIN_STATUS_TEXT_LEN = 40;

/**
 * Normalize a round's assistant text so semantically-equivalent status
 * restatements collapse to one key: drop digits (counts change: "3/5"→"4/5"),
 * markdown table/formatting punctuation, and whitespace. Two rounds that say the
 * same thing with different numbers hash identically.
 */
function normalizeStatusText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0-9]+/g, "")
    .replace(/[|`*_#>\-+=~[\](){}.,:;!?/\\'"]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type AgenticRepetitionOutcome =
  | { kind: "none" }
  | { kind: "loop_correct"; attempt: 1 | 2; toolName: string; count: number }
  | { kind: "loop_abort"; toolName: string; target: string; count: number };

export interface AgenticRepetitionState {
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  record(toolName: string, args: unknown): AgenticRepetitionOutcome;
  /**
   * v14.8.7 §A5: record a round's assistant TEXT; trips loop_abort when the same
   * substantial status-like text repeats TEXT_REPETITION_THRESHOLD rounds in a
   * row (numbers ignored). Independent of the tool-call counter above.
   */
  recordText(text: string): AgenticRepetitionOutcome;
  /** Inert — corrections were removed; retained for interface compatibility. */
  takePendingCorrection(): string | null;
  /** Inert — hard loop-break is the caller's force-finish, not a return flag. */
  consumeLoopBreak(): boolean;
}

/**
 * Corrective text for a `loop_correct` outcome — returned to the model AS the
 * tool result (instead of executing the repeated call), so guidance flows down
 * the channel the model is already reading. Tool-tailored steer; attempt 2 adds
 * an explicit invitation to stop on the model's own terms.
 */
export function buildLoopCorrectionMessage(outcome: {
  attempt: 1 | 2;
  toolName: string;
  count: number;
}): string {
  const { attempt, toolName, count } = outcome;
  const steer =
    toolName === "edit_file" || toolName === "write_file"
      ? "The file may have changed since you last read it — re-read the file and re-derive the edit from its CURRENT content."
      : toolName === "grep" || toolName === "glob"
        ? "The search is not finding what you expect — read the likely file directly with read_file instead of searching again."
        : toolName === "run_command"
          ? "Re-running it will produce the same outcome — inspect the error output and change the command or fix the underlying problem first."
          : "Change your approach — gather different information or try a different tool.";
  const base =
    `You have made this exact ${toolName} call ${count} times in a row with identical input, ` +
    `and the result will not change. This call was NOT executed. Do not repeat it. ${steer}`;
  if (attempt === 1) return base;
  return (
    base +
    " If you cannot make progress on this step, do not keep trying: state what is blocked, " +
    "mark the plan step accordingly, and either move on to the next step or end your turn with a status report."
  );
}

/** Byte-identical key for a tool call (matches opencode's JSON.stringify(input)). */
function doomKey(toolName: string, args: unknown): string {
  let inputJson: string;
  try {
    inputJson = JSON.stringify(args) ?? "";
  } catch {
    // Non-serializable args can't be compared for byte-identity — treat as unique.
    inputJson = `__nonserializable__${Math.max(0, recentNonce++)}`;
  }
  return `${toolName}\u0000${inputJson}`;
}

// Module-level nonce so non-serializable inputs never collide (no Date/random).
let recentNonce = 0;

export function createAgenticRepetitionState(): AgenticRepetitionState {
  let enabled = false;
  // The last call's key + how many times in a row it has now repeated.
  let lastKey: string | null = null;
  let consecutive = 0;
  // §A5: parallel state for assistant-text repetition.
  let lastTextKey: string | null = null;
  let textConsecutive = 0;

  return {
    setEnabled(v: boolean) {
      enabled = v;
      lastKey = null;
      consecutive = 0;
      lastTextKey = null;
      textConsecutive = 0;
    },
    isEnabled() {
      return enabled;
    },
    record(toolName: string, args: unknown): AgenticRepetitionOutcome {
      if (!enabled) return { kind: "none" };
      const key = doomKey(toolName, args);
      if (key === lastKey) {
        consecutive++;
      } else {
        lastKey = key;
        consecutive = 1;
      }
      // Staged escalation — fire exactly ON each threshold (not past it), so a
      // model that keeps repeating gets one correction per stage, then the
      // backstop. The count is NOT reset on a correction trip: only a different
      // call resets it (see header).
      if (consecutive === CORRECT_1_THRESHOLD) {
        return {
          kind: "loop_correct",
          attempt: 1,
          toolName,
          count: consecutive,
        };
      }
      if (consecutive === CORRECT_2_THRESHOLD) {
        return {
          kind: "loop_correct",
          attempt: 2,
          toolName,
          count: consecutive,
        };
      }
      if (consecutive >= ABORT_THRESHOLD) {
        // Reset so one doom loop fires exactly one force-finish.
        const count = consecutive;
        consecutive = 0;
        lastKey = null;
        return { kind: "loop_abort", toolName, target: "", count };
      }
      return { kind: "none" };
    },
    recordText(text: string): AgenticRepetitionOutcome {
      if (!enabled) return { kind: "none" };
      const key = normalizeStatusText(text);
      // Only substantial status-like text counts — short confirmations
      // ("done", "ok") repeating is harmless and must not trip.
      if (key.length < MIN_STATUS_TEXT_LEN) {
        lastTextKey = null;
        textConsecutive = 0;
        return { kind: "none" };
      }
      if (key === lastTextKey) {
        textConsecutive++;
      } else {
        lastTextKey = key;
        textConsecutive = 1;
      }
      // Staged like tool calls: first trip corrects (the engine injects
      // round-boundary feedback), a second full run of repeats aborts.
      if (textConsecutive === TEXT_REPETITION_THRESHOLD) {
        return {
          kind: "loop_correct",
          attempt: 1,
          toolName: "(assistant text)",
          count: textConsecutive,
        };
      }
      if (textConsecutive >= TEXT_REPETITION_THRESHOLD * 2) {
        textConsecutive = 0;
        lastTextKey = null;
        return {
          kind: "loop_abort",
          toolName: "(assistant text)",
          target: "repeated status restatement",
          count: TEXT_REPETITION_THRESHOLD * 2,
        };
      }
      return { kind: "none" };
    },
    takePendingCorrection() {
      return null;
    },
    consumeLoopBreak() {
      return false;
    },
  };
}
