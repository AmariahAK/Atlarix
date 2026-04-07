import { Filter } from "bad-words";
import { SAFETY_FILTER_BLOCKED_MESSAGE } from "@/shared/texts";

const filter = new Filter();

export class ChatPromptSafetyError extends Error {
  constructor(message: string = SAFETY_FILTER_BLOCKED_MESSAGE) {
    super(message);
    this.name = "ChatPromptSafetyError";
  }
}

export function assertUserMessageAllowed(text: string): void {
  if (filter.isProfane(text)) {
    throw new ChatPromptSafetyError();
  }
}

/**
 * Run profanity clean on text outside ``` fenced blocks ``` so code samples stay intact.
 */
export function sanitizeAssistantOutput(text: string): string {
  const fenceRe = /```[\s\S]*?```/g;
  let last = 0;
  let out = "";
  let m: RegExpExecArray | null;
  const re = new RegExp(fenceRe.source, fenceRe.flags);
  while ((m = re.exec(text)) !== null) {
    out += filter.clean(text.slice(last, m.index));
    out += m[0];
    last = m.index + m[0].length;
  }
  out += filter.clean(text.slice(last));
  return out;
}
