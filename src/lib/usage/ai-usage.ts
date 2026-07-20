export type LooseAiUsage = {
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  thinkingTokens?: number;
  completionTokensDetails?: { reasoningTokens?: number; thinkingTokens?: number };
  outputTokensDetails?: { reasoningTokens?: number; thinkingTokens?: number };
};

/** Best-effort reasoning / thinking token count from provider usage objects. */
export function reasoningTokensFromAiUsage(
  usage: LooseAiUsage | undefined | null,
): number | null {
  if (!usage) return null;
  const u = usage as Record<string, unknown>;
  const direct =
    (typeof usage.reasoningTokens === "number" ? usage.reasoningTokens : null) ??
    (typeof usage.thinkingTokens === "number" ? usage.thinkingTokens : null);
  if (typeof direct === "number" && direct > 0) {
    return Math.round(direct);
  }
  // ai@6 nests reasoning under `outputTokenDetails` (top-level
  // `reasoningTokens` still set but deprecated).
  const ctd =
    usage.completionTokensDetails ??
    usage.outputTokensDetails ??
    (u["outputTokenDetails"] as LooseAiUsage["outputTokensDetails"]);
  if (ctd) {
    const r =
      (typeof ctd.reasoningTokens === "number" ? ctd.reasoningTokens : null) ??
      (typeof ctd.thinkingTokens === "number" ? ctd.thinkingTokens : null);
    if (typeof r === "number" && r > 0) return Math.round(r);
  }
  const nested = u["completion_tokens_details"] as { reasoning_tokens?: number } | undefined;
  if (nested && typeof nested.reasoning_tokens === "number" && nested.reasoning_tokens > 0) {
    return Math.round(nested.reasoning_tokens);
  }
  return null;
}

/** Normalize AI SDK / provider usage into a single token count. */
export function totalTokensFromAiUsage(
  usage: LooseAiUsage | undefined | null,
): number | null {
  if (!usage) return null;
  if (typeof usage.totalTokens === "number" && usage.totalTokens > 0) {
    return Math.round(usage.totalTokens);
  }
  const p =
    typeof usage.promptTokens === "number"
      ? usage.promptTokens
      : typeof usage.inputTokens === "number"
        ? usage.inputTokens
        : null;
  const c =
    typeof usage.completionTokens === "number"
      ? usage.completionTokens
      : typeof usage.outputTokens === "number"
        ? usage.outputTokens
        : null;
  const extra = reasoningTokensFromAiUsage(usage) ?? 0;
  if (p != null && c != null && p + c + extra > 0) {
    return Math.round(p + c + extra);
  }
  return null;
}
