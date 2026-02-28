/**
 * Keyword signal arrays for two-stage auto router classification.
 * Used in Stage 1 heuristic; confidence > 0.85 skips Stage 2.
 */

export const ARCHITECTURE_SIGNALS = [
  "design",
  "architecture",
  "blueprint",
  "structure",
  "system design",
  "database schema",
  "api design",
  "refactor",
  "restructure",
  "how should i",
  "what approach",
  "pattern",
  "scalable",
  "monolith",
  "microservice",
  "how would you",
  "best way to build",
  "scaffold",
];

export const SECURITY_SIGNALS = [
  "security",
  "vulnerability",
  "exploit",
  "auth",
  "permission",
  "sql injection",
  "xss",
  "csrf",
  "audit",
  "sanitize",
  "encrypt",
  "token",
  "secret",
  "password",
  "hash",
  "certificate",
  "oauth",
];

export const RESEARCH_SIGNALS = [
  "how does",
  "what is",
  "explain",
  "compare",
  "best practice",
  "research",
  "find",
  "look up",
  "alternatives to",
  "vs ",
  "versus",
  "pros and cons",
  "tradeoff",
  "difference between",
  "should i use",
];

export const DEBUG_SIGNALS = [
  "error",
  "bug",
  "fix",
  "broken",
  "not working",
  "failing",
  "crash",
  "exception",
  "undefined",
  "null",
  "typeerror",
  "cannot read",
  "unexpected",
  "wrong output",
  "doesnt work",
  "doesn't work",
  "issue",
];

export const REASONING_SIGNALS = [
  "should i",
  "trade-off",
  "pros and cons",
  "approach",
  "think through",
  "strategy",
  "plan",
  "optimize",
  "improve",
  "evaluate",
  "decide",
  "recommend",
  "advise",
  "weigh",
  "consider",
];

export const CODE_GENERATION_SIGNALS = [
  "create",
  "implement",
  "add",
  "write",
  "generate",
  "build",
  "new component",
  "new function",
  "new api",
  "new endpoint",
  "scaffold",
  "boilerplate",
];

export const SIMPLE_EDIT_SIGNALS = [
  "change",
  "update",
  "replace",
  "rename",
  "move",
  "delete",
  "edit",
  "modify",
  "tweak",
];

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

export type RoutingCategory =
  | "chit_chat"
  | "simple_edit"
  | "code_generation"
  | "debugging"
  | "architecture"
  | "deep_research"
  | "security_review"
  | "complex_reasoning";
