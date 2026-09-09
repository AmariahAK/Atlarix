import { sanitizePromptInput } from "./prompt-hygiene";
import {
  assertUserMessageAllowed,
  ChatPromptSafetyError,
} from "./profanity-filter";

export { ChatPromptSafetyError };

/**
 * Hygiene + profanity check for one user turn. Call at chat IPC entry (and on continue-after-Q from DB content).
 */
export function prepareUserChatTurnInput(raw: string): string {
  const s = sanitizePromptInput(raw);
  assertUserMessageAllowed(s);
  return s;
}
