import type { ModelTier } from "@/lib/routing/capability-registry";
import type { CounselTrigger } from "./counsel-session";

const EXPLICIT_SUBSTRINGS = [
  "/counsel",
  "counsel this",
  "get all perspectives",
  "think this through together",
  "multiple perspectives",
];

export type CounselChatMode =
  | "ask"
  | "plan"
  | "build"
  | "debug"
  | "agent"
  | string;

export function detectCounselTrigger(
  message: string,
  resolvedTier: ModelTier,
  opts?: {
    autoTriggerOnThinking?: boolean;
    /** When `ask`, auto-trigger is disabled (explicit /counsel still works). */
    selectedChatMode?: CounselChatMode;
  },
): CounselTrigger | null {
  const lower = message.toLowerCase();
  if (EXPLICIT_SUBSTRINGS.some((cmd) => lower.includes(cmd))) {
    return "user_command";
  }

  const mode = (opts?.selectedChatMode ?? "build").toLowerCase();
  if (mode === "ask") {
    return null;
  }

  const wordCount = message.split(/\s+/).filter(Boolean).length;
  const autoOn = opts?.autoTriggerOnThinking !== false;
  // Auto counsel: Thinking or Balanced tier with substantive prompts, or long prompts on any tier.
  if (
    autoOn &&
    wordCount > 8 &&
    (resolvedTier === "thinking" || resolvedTier === "balanced")
  ) {
    return "auto_complex";
  }
  if (autoOn && wordCount >= 20) {
    return "auto_complex";
  }

  return null;
}

export function stripCounselCommand(message: string): string {
  return message
    .replace(/\/counsel\s*/gi, "")
    .replace(/counsel this\s*/gi, "")
    .trim();
}
