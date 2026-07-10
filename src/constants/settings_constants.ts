/** Default chat turns (user+assistant pairs) sent to AI. Raised from 3 for better context (Phase 5). */
export const MAX_CHAT_TURNS_IN_CONTEXT = 10;

/**
 * Wall-clock cap for long-running multi-round workspace tool streams.
 * Disabled (Infinity): the agentic loop runs until the model finishes, the user
 * aborts, or the abort signal fires — no internal time cap. (The benchmark
 * harness imposes its own per-task timeout.) Was 30 min; removed as an
 * unintended limit on autonomous/headless runs.
 */
export const STREAM_TOOL_LOOP_DURATION_CAP_MS = Number.POSITIVE_INFINITY;

