/**
 * Normalize user chat input at the IPC boundary. Not a substitute for execution-boundary validation (e.g. SQL guards).
 */

/** Aligned with practical model context — prevents absurd payloads and NUL injection. */
export const MAX_USER_CHAT_PROMPT_CHARS = 200_000;

export function sanitizePromptInput(raw: string): string {
  if (typeof raw !== "string") {
    throw new Error("Invalid prompt");
  }
  const s = raw.replace(/\0/g, "").normalize("NFC").trim();
  if (s.length > MAX_USER_CHAT_PROMPT_CHARS) {
    throw new Error(
      `Message exceeds maximum length (${MAX_USER_CHAT_PROMPT_CHARS} characters)`,
    );
  }
  return s;
}
