/**
 * `ask_user` — the tool that replaces guessing.
 *
 * WHY IT EARNS ITS PLACE HERE MORE THAN IT DOES IN THE APP. This agent acts on
 * the user's real, logged-in browser. "Which of these three accounts did you
 * mean?" is worth a round trip, and the alternative — today's behaviour — is to
 * pick one and act on it.
 *
 * THE WHOLE CONTRACT IS THAT THE TURN ENDS. The tool returns `endsTurn`, the
 * loop finishes the batch and returns `{kind:"asked"}`, and the user's answer
 * arrives as an ordinary next user message that starts a fresh turn. There is
 * no waiting, no promise held open across a panel close, and no timeout —
 * which is what makes a question survive the panel being shut, unlike the
 * approval card, whose promise dies with the document.
 *
 * THE NORMALISATION IS IMPORTED, NOT COPIED. `@/lib/tools/ask_user_options` is
 * a zero-import leaf the desktop already uses, and the extension's tsconfig
 * reaches into the app's `src` for exactly this reason — "a second copy of the
 * walker is a second contract". The behaviours it buys were each paid for by a
 * real model doing a real strange thing: `{label, description}` objects instead
 * of strings (minimax over OpenRouter, where `String({…})` yields
 * "[object Object]" and the Set-dedup collapses every option into one), inline
 * numbered lines inside `question`, comma lists after "Pick one:", and `choices`
 * as an alias for `options`.
 */

import {
  ASK_USER_MAX_OPTIONS,
  ASK_USER_MAX_QUESTIONS,
  normalizeAskUserQuestions,
  type AskUserQuestion,
} from "@/lib/tools/ask_user_options";
import type { ToolOutcome } from "./dispatch";

export type { AskUserQuestion };
export { ASK_USER_MAX_OPTIONS, ASK_USER_MAX_QUESTIONS };

/**
 * Pull the questions back out of a recorded `ask_user` call.
 *
 * THIS IS HOW A QUESTION SURVIVES A RELOAD. The panel does not keep asked
 * questions in module state; it re-derives them from the assistant message's
 * `tool_calls`, which `saveSession` already persists. So reopening the panel
 * shows the question exactly as it was asked, and `renderConversation` needs no
 * new storage.
 *
 * Returns [] for anything it cannot read, because a malformed record must
 * render as nothing rather than throw inside a transcript rebuild.
 */
export function questionsFromArgs(rawArgs: string): AskUserQuestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return normalizeAskUserQuestions(parsed as Record<string, unknown>);
}

/** A short phrase for the transcript chip. */
export function askUserLabel(questions: AskUserQuestion[]): string {
  if (questions.length === 0) return "Asked the user";
  if (questions.length === 1) return "Asked a question";
  return `Asked ${questions.length} questions`;
}

/**
 * Run the tool.
 *
 * The `content` is written for the MODEL, not the user — the user reads the
 * rendered questions in the panel. Its job is to stop the model doing anything
 * else, which is why it states the ending as a fact that has already happened
 * rather than as an instruction it could weigh.
 */
export function askUser(args: Record<string, unknown>): ToolOutcome {
  const questions = normalizeAskUserQuestions(args);

  // NOT an error the model should retry differently — a call with nothing
  // readable in it is a call that asked nothing, so the turn must NOT end or
  // the user gets a silent stop with no question on screen.
  if (questions.length === 0) {
    return {
      content:
        "You called ask_user with no readable question, so nothing was asked " +
        "and your turn is still running. Pass `questions` as an array of " +
        "{question, options} — or a single `question` string — and call it again.",
      label: "Asked nothing",
    };
  }

  const asked = questions.length === 1 ? "Your question is" : "Your questions are";
  return {
    content:
      `${asked} now in front of the user and YOUR TURN HAS ENDED. Do not ` +
      `continue, do not call another tool, and do not answer on their behalf. ` +
      `Their reply will arrive as the next message.`,
    label: askUserLabel(questions),
    endsTurn: true,
  };
}
