/**
 * The agent's reason for a command it asks to run, as every approval card shows
 * it ("Reason: Can I check whether the PR has merge conflicts?"). Model text, so
 * it is cleaned once, where the request is made: one line, no control
 * characters (nothing for a terminal to act on), bounded. The cards add only a
 * "Reason:" label and draw it as plain text, and the command is always shown
 * too: it is what the user approves, never the reason.
 */
export const APPROVAL_REASON_CAP = 200;

// eslint-disable-next-line no-control-regex -- removing them is the point
const CONTROL = /[\x00-\x08\x0e-\x1f\x7f-\x9f]/g;

export function approvalReason(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.replace(CONTROL, "").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > APPROVAL_REASON_CAP ? `${text.slice(0, APPROVAL_REASON_CAP - 1).trimEnd()}…` : text;
}
