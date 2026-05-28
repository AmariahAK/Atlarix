export const AI_STREAMING_ERROR_MESSAGE_PREFIX =
  "Sorry, there was an error from the AI: ";

/** Shown when the model finishes without text (AI SDK no-output / empty stream). */
export const AI_STREAM_EMPTY_RESPONSE_FALLBACK =
  "Something went wrong — please try again.";

/** User message rejected by local profanity filter (bad-words list — not full moderation). */
export const SAFETY_FILTER_BLOCKED_MESSAGE =
  "Message blocked by safety filter.";

/** Shown when the selected model fails (no automatic failover to another model). */
export function modelFailureUserMessage(reason: string): string {
  const detail = reason.trim() || "the request failed";
  return `This model failed (${detail}). Choose a different model in chat settings or switch provider.`;
}
