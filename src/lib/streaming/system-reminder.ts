/**
 * Out-of-band harness messages (v14.8.8).
 *
 * The harness injects continuation nudges, background/sub-agent results, mode
 * re-anchors, the task ledger, gate feedback, etc. into the conversation. They
 * are delivered as `role:"user"` messages because providers (Anthropic in
 * particular) don't accept a mid-conversation `role:"system"` turn — but a
 * recency-biased model (open-weight especially) then mistakes a harness resume
 * or nudge for a fresh USER request.
 *
 * Fix (Claude Code's mechanism): wrap harness-injected content in a visible
 * `<system-reminder>` tag so the model can tell it apart from a genuine user
 * turn. Only untagged user turns are real user input. The convention is
 * documented once in the system prompt.
 */

export const SYSTEM_REMINDER_OPEN = "<system-reminder>";
export const SYSTEM_REMINDER_CLOSE = "</system-reminder>";

/**
 * Wrap harness-injected content as an out-of-band system-reminder. Returns the
 * body unchanged when it is empty (nothing to frame) or already wrapped (avoids
 * double-tagging when composing).
 */
export function systemReminder(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return body;
  if (trimmed.startsWith(SYSTEM_REMINDER_OPEN)) return body;
  return `${SYSTEM_REMINDER_OPEN}\n${trimmed}\n${SYSTEM_REMINDER_CLOSE}`;
}

/**
 * The text with every `<system-reminder>` block removed — for showing a user row's
 * model content to the person who typed it (project memory rides those rows).
 */
export function stripSystemReminders(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "")
    .trim();
}
