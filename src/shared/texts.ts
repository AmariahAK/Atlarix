export const AI_STREAMING_ERROR_MESSAGE_PREFIX =
  "Sorry, there was an error from the AI: ";

/** Shown when the model finishes without text (AI SDK no-output / empty stream). */
export const AI_STREAM_EMPTY_RESPONSE_FALLBACK =
  "The model returned no text. Try again, pick a different model, or check your provider connection and limits.";

/** User message rejected by local profanity filter (bad-words list — not full moderation). */
export const SAFETY_FILTER_BLOCKED_MESSAGE =
  "Message blocked by safety filter.";
