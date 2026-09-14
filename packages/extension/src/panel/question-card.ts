import type { AskUserQuestion } from "../tools/ask-user";

/** What a skipped question sends, matching the desktop's `SKIP_ANSWER`. */
export const SKIP_ANSWER = "(skipped)";

/**
 * The card `ask_user` renders.
 *
 * NOT A PROMISE, UNLIKE `approvalCard` — and that difference is the feature.
 * An approval card holds a promise the loop is waiting on, so it dies with the
 * document: close the panel and the question is gone. A question must outlive
 * that, because the whole point is that the user answers whenever they like.
 * So this renders from the RECORDED tool call and resolves nothing; the answer
 * is an ordinary next message.
 *
 * ══ THE SHAPE IS THE DESKTOP'S, DELIBERATELY ══
 *
 * `src/components/chat/InlineUserQuestions.tsx` had already solved this and the
 * first version of this card did not look at it. Three things it gets right
 * that wrapped chips got wrong:
 *
 *   - ONE OPTION PER ROW, NUMBERED. Chips wrapped by text width, so four
 *     options laid out as 1 / 2-3 / 4 and the reading order stopped matching
 *     the order the model wrote them in. The CSS comment defending that
 *     claimed stacking would "push the composer off a short panel" — it does
 *     not: the card scrolls with the transcript, and a scrambled list is worse
 *     than a scroll.
 *   - A REAL SURFACE. Transparent pills with a hairline border inherited the
 *     body colour and were reported as looking "just like text", which is
 *     exactly what they looked like.
 *   - SKIP. "No answer" is a legitimate answer to a question the agent guessed
 *     at, and without an affordance the only way to give one is to type prose
 *     explaining that you have nothing to say.
 *
 * FILLING THE COMPOSER, NOT SENDING. One consistent rule, decided by the case
 * that breaks the alternative: with three questions on screen a click that sent
 * immediately would answer the first and discard the rest. Filling also leaves
 * the answer editable, which matters when the right answer is "the second one,
 * but only for today".
 *
 * `fill` is injected rather than reached for, so every behaviour here is
 * testable without mounting the panel.
 */
export function buildQuestionCard(
  questions: AskUserQuestion[],
  fill: (text: string) => void,
): HTMLElement {
  const card = document.createElement("div");
  card.className = "ask";
  const multi = questions.length > 1;

  const header = document.createElement("div");
  header.className = "ask__header";
  header.textContent = multi
    ? `${questions.length} questions — answer what you can`
    : "Question";
  card.append(header);

  /**
   * `Q: … A: …` once there is more than one question, which is exactly
   * `combineAnswers` on the desktop. Without it the model receives three
   * answers in a row with nothing saying which belongs to which — and the
   * user clicks them one at a time, so there is no other moment to pair them.
   */
  const answer = (question: string, text: string) =>
    fill(multi ? `Q: ${question}\nA: ${text}` : text);

  questions.forEach((q, qi) => {
    const block = document.createElement("div");
    block.className = "ask__block";

    const heading = document.createElement("div");
    heading.className = "ask__question";
    heading.textContent = multi ? `${qi + 1}. ${q.question}` : q.question;
    block.append(heading);

    const list = document.createElement("div");
    list.className = "ask__options";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Suggested answers");

    (q.options ?? []).forEach((option, oi) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ask__option";
      row.setAttribute("role", "option");

      // The number STATES the order rather than leaving it to be inferred from
      // position — which is the whole reason this is a list and not a wrap.
      const num = document.createElement("span");
      num.className = "ask__option-num";
      num.textContent = String(oi + 1);
      const label = document.createElement("span");
      label.className = "ask__option-label";
      label.textContent = option;
      row.append(num, label);

      row.addEventListener("click", () => answer(q.question, option));
      list.append(row);
    });

    // Always offered, with options or without: a question the agent guessed at
    // deserves an answer that costs no typing.
    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "ask__option ask__option--skip";
    const skipLabel = document.createElement("span");
    skipLabel.className = "ask__option-label";
    skipLabel.textContent = multi ? "Skip this one" : "Skip — no preference";
    skip.append(skipLabel);
    skip.addEventListener("click", () => answer(q.question, SKIP_ANSWER));
    list.append(skip);

    block.append(list);
    card.append(block);
  });

  const note = document.createElement("p");
  note.className = "ask__note";
  note.textContent = "Pick one, or type your own answer below.";
  card.append(note);

  return card;
}
