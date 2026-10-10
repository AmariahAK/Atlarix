/**
 * The session recap in the side panel: when you come back to the panel after a
 * few minutes away, one line on where the conversation stands. When it is due
 * is the shared rule (src/lib/recap/rules.ts, the same for the app, the CLI and
 * the editors); this writes it, on the panel's own Atlarix Auto.
 *
 * Shown, never saved, never sent back to the model — and silent on failure, like
 * a title: a recap that could not be written is not the user's problem.
 */
import { clampRecap } from "@/lib/recap/rules";
import { streamTurn, type CoreMessage } from "../core/client";

/** Covers a reasoning model's thinking before the line (see TITLE_OUTPUT_TOKENS). */
const RECAP_OUTPUT_TOKENS = 768;

const INSTRUCTION =
  "You write the one-line recap a user sees when they come back to an Atlarix " +
  "conversation after stepping away. In ONE plain sentence (two at most, under " +
  "60 words) say what the task is, what is done, and what is next or waiting on " +
  "them. No greeting, no preamble, no markdown.";

function text(m: CoreMessage): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return (m.content as Array<{ type?: string; text?: string }>)
      .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
      .join(" ");
  }
  return "";
}

export async function generateRecapLine(
  model: string,
  messages: CoreMessage[],
  opts: { signal?: AbortSignal; stream?: typeof streamTurn } = {},
): Promise<string> {
  const run = opts.stream ?? streamTurn;
  const conversation = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "User" : "Atlarix"}: ${text(m)}`)
    .filter((l) => l.length > 10)
    .join("\n\n")
    .slice(-24_000);
  if (!conversation) return "";
  let out = "";
  try {
    for await (const event of run(
      {
        model,
        messages: [
          { role: "system", content: INSTRUCTION },
          { role: "user", content: `<conversation>\n${conversation}\n</conversation>\n\nThe recap:` },
        ],
        maxOutputTokens: RECAP_OUTPUT_TOKENS,
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
  return clampRecap(out);
}
