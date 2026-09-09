// MAX_CHAT_TURNS_IN_CONTEXT REMOVED (v14.18.0). A count-based history cap has no
// relationship to a model's context window: it deleted half a 124,907-token
// session on a 1,000,000-token model at 8.9% fill, because the conversation
// crossed eleven turns. Tokens are the only meaningful unit here, and the token
// budget + compaction now own the decision entirely.

/**
 * Wall-clock cap for long-running multi-round workspace tool streams.
 * Disabled (Infinity): the agentic loop runs until the model finishes, the user
 * aborts, or the abort signal fires — no internal time cap. (The benchmark
 * harness imposes its own per-task timeout.) Was 30 min; removed as an
 * unintended limit on autonomous/headless runs.
 */
export const STREAM_TOOL_LOOP_DURATION_CAP_MS = Number.POSITIVE_INFINITY;
