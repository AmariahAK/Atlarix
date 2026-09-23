/**
 * Naming a conversation.
 *
 * WHY NOT JUST THE FIRST MESSAGE. Because that is what it did, and the drawer
 * filled up with rows reading "hey how are you? could u tell me what url we are
 * on…" — a string that is technically the question and useless as a label. The
 * whole job of a history list is to let someone find the conversation they mean
 * at a glance, and a truncated opener defeats it precisely when there are enough
 * conversations for the list to matter.
 *
 * ONE SMALL CALL, ONCE PER CONVERSATION, and it is deliberately the cheapest
 * thing in the file: no tools, a hard token cap, and only the first exchange as
 * input. A title is not worth a second of latency in front of the answer, so it
 * runs AFTER the turn has finished rendering and quietly replaces the derived
 * one when it arrives.
 *
 * IT FAILS SILENTLY ON PURPOSE. A conversation that could not be named is not a
 * problem the user has — the derived title is still there and still says
 * something. Putting an error on screen for it would be noise about a cosmetic
 * feature, on a panel where the status line is already carrying real news.
 */

import { streamTurn, type CoreMessage } from "../core/client";

/** Long enough to be specific, short enough not to be truncated in the drawer. */
export const MAX_TITLE_LENGTH = 48;

/**
 * The output budget, and it is NOT the length of a title.
 *
 * IT WAS 32, AND THAT IS WHY NOTHING WAS EVER NAMED. Core 1 is GLM 5.3, a
 * REASONING model: it spends output tokens thinking before it writes a single
 * character of answer. A 32-token cap is consumed entirely by the thinking, the
 * response is truncated before `content` ever begins, and the caller gets an
 * empty string — silently, because an unnamed conversation is not an error.
 *
 * "Small number, small answer" is the intuition, and on a reasoning model it is
 * exactly backwards: the cap has to cover the thinking the answer comes AFTER.
 * 512 is a fraction of a cent per conversation and removes the failure entirely.
 */
export const TITLE_OUTPUT_TOKENS = 512;

const INSTRUCTION =
  "Write a title for this conversation: 2 to 5 words, no quotes, no trailing " +
  "full stop, sentence case. Name the SUBJECT, not the request — " +
  '"Wikipedia random articles", never "User asks about a URL". ' +
  "Reply with the title and nothing else.";

/** Trim a model's answer down to something that belongs in a list. */
export function cleanTitle(raw: string): string {
  const oneLine = raw
    .replace(/\s+/g, " ")
    .trim()
    // Models wrap a title in quotes about a third of the time however firmly
    // they are told not to.
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    // And prefix it with a label about as often.
    .replace(/^(title|conversation)\s*[:\-–]\s*/i, "")
    .replace(/[.]+$/, "")
    .trim();
  if (!oneLine) return "";
  return oneLine.length > MAX_TITLE_LENGTH
    ? `${oneLine.slice(0, MAX_TITLE_LENGTH - 1)}…`
    : oneLine;
}

/**
 * Ask the model for a title. Empty string when it could not produce one.
 *
 * The transcript is reduced to the first exchange and clipped hard: a title for
 * a conversation that read six pages must not cost what reading them did.
 */
export async function generateTitle(
  model: string,
  messages: CoreMessage[],
  opts: { signal?: AbortSignal; stream?: typeof streamTurn } = {},
): Promise<string> {
  const run = opts.stream ?? streamTurn;

  const firstUser = messages.find((m) => m.role === "user");
  const firstReply = messages.find(
    (m) => m.role === "assistant" && typeof m.content === "string" && m.content,
  );
  if (!firstUser || typeof firstUser.content !== "string") return "";

  const transcript: CoreMessage[] = [
    { role: "system", content: INSTRUCTION },
    {
      role: "user",
      content:
        `Question: ${firstUser.content.slice(0, 600)}` +
        (firstReply && typeof firstReply.content === "string"
          ? `\n\nAnswer: ${firstReply.content.slice(0, 600)}`
          : ""),
    },
  ];

  let out = "";
  try {
    for await (const event of run(
      {
        model,
        messages: transcript,
        // No tools. A title call that decided to read a page would be absurd,
        // and the client omits the field entirely when the list is empty.
        maxOutputTokens: TITLE_OUTPUT_TOKENS,
        purpose: "title",
        signal: opts.signal,
      },
      fetch,
    )) {
      if (event.type === "text") out += event.delta;
    }
  } catch {
    return "";
  }
  return cleanTitle(out);
}
