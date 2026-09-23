/**
 * The one model call compaction makes, on the same tier the conversation is
 * running on.
 *
 * SAME TIER, NOT A CHEAP ONE. Splitting summarisation onto a smaller model is
 * tempting and wrong here: the summary becomes the conversation's entire memory
 * of what happened, so a worse model at that step degrades every round after it,
 * permanently, and the saving is one call against a conversation that has
 * already made dozens. Core's tiers are also selected by the user, and silently
 * routing part of their turn elsewhere is not ours to do.
 */

import { streamTurn, type CoreMessage } from "../core/client";

/**
 * The output budget for a summary.
 *
 * SIZED FOR A REASONING MODEL, and this is the same trap that made
 * `TITLE_OUTPUT_TOKENS = 32` produce nothing at all: Core 1 is GLM 5.3, which
 * spends output tokens thinking before it writes a character. The cap has to
 * cover the thinking the answer comes AFTER. A nine-section summary needs
 * perhaps 800 tokens of text; 4,096 leaves room to reach it.
 */
export const COMPACTION_OUTPUT_TOKENS = 4_096;

/**
 * Run the summariser and return its text.
 *
 * NO TOOLS, deliberately. A summariser that decided to read a page would be
 * compacting the context by adding to it.
 *
 * Throws on failure, because the caller — `compactConversation` — has a real
 * answer for that: it keeps whatever the two free steps already achieved and
 * carries on. Swallowing the error here would report a successful compaction
 * that summarised nothing.
 */
export function summariserFor(
  model: string,
  stream: typeof streamTurn = streamTurn,
) {
  return async function summarise(
    messages: CoreMessage[],
    signal?: AbortSignal,
  ): Promise<string> {
    let out = "";
    for await (const event of stream(
      {
        model,
        messages,
        maxOutputTokens: COMPACTION_OUTPUT_TOKENS,
        signal,
        purpose: "compaction",
      },
      fetch,
    )) {
      if (event.type === "text") out += event.delta;
    }
    return out;
  };
}
