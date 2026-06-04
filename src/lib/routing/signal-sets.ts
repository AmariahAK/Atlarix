/**
 * Keyword signal arrays for two-stage auto router classification.
 * Used in Stage 1 heuristic; confidence > 0.85 skips Stage 2.
 */

export const CHIT_CHAT_PATTERNS = [
  /^(ok|okay|thanks|thank you|got it|sounds good|great|perfect|done|yes|no|sure)\.?$/i,
  /^(can you|please|could you)\s+(continue|proceed|go ahead|keep going)/i,
  /^(hello|hi|hey|sup|what's up)/i,
];

export const FAST_MODEL_KEYWORDS = [
  "flash",
  "mini",
  "haiku",
  "small",
  "3b",
  "7b",
  "8b",
  "lite",
  "nano",
  "tiny",
];

export const THINKING_MODEL_KEYWORDS = [
  "opus",
  "o1",
  "o3",
  "r1",
  "thinking",
  "reasoning",
  "deep",
  "70b",
  "72b",
  "405b",
  "671b",
];

