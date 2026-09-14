import type { AskUserQuestion } from "../tools/ask-user";

/** What a skipped question sends, matching the desktop's `SKIP_ANSWER`. */
export const SKIP_ANSWER = "(skipped)";

export interface QuestionCardHost {
  /**
   * Send the answer as a user message, exactly as the composer would.
   *
   * TWO ARGUMENTS, mirroring the desktop's IPC
   * (`ipc_client.ts:submitUserQuestionAnswer`), because the QUESTION is part of
   * the message the model receives — not metadata and not a display label. The
   * panel does the formatting with the same `formatInteractiveQaLine` the
   * desktop's main process uses, so both surfaces send a byte-identical string.
   *
   * `questionText` is the question itself for one, `"N questions"` for several,
   * exactly as `InlineUserQuestions.tsx:118-123` decides it.
   */
  send(questionText: string, answer: string): void;
}

/**
 * The card `ask_user` renders.
 *
 * NOT A PROMISE, UNLIKE `approvalCard` — and that difference is the feature.
 * An approval card holds a promise the loop is waiting on, so it dies with the
 * document: close the panel and the question is gone. A question must outlive
 * that, because the whole point is that the user answers whenever they like.
 * So this renders from the RECORDED tool call and resolves nothing; the answer
 * is an ordinary user message.
 *
 * ══ PICKING SENDS. IT DOES NOT FILL THE COMPOSER. ══
 *
 * The first version put the option's text in the composer and left it there.
 * The reasoning was that with three questions on screen, a click that sent
 * immediately would answer the first and discard the rest — which is a real
 * problem and the wrong solution to it. What it produced was a click that
 * looked like it had done nothing, and an answer that arrived as text the user
 * appeared to have typed rather than as a choice they had made.
 *
 * The desktop had already solved the multi-question case properly and this now
 * copies it (`InlineUserQuestions.tsx`):
 *
 *   - ONE question with options: clicking an option SENDS. No second gesture,
 *     because there is nothing else to wait for.
 *   - SEVERAL questions, or one with no options: clicking SELECTS, the choice
 *     is visibly marked, and a Send button appears — disabled until every
 *     question has an answer, so a half-filled card cannot be sent by accident.
 *
 * The card also carries its own "Something else" field per question, again like
 * the desktop. Without it, typing an answer means the composer, and then half
 * the answers live in the card and half in a textarea with nothing combining
 * them.
 *
 * ══ SKIP IS ONE BUTTON, LAST, AND IT SUBMITS ══
 *
 * It was a row per question, sitting between the options and the free-text
 * field — so the last thing before "Something else…" was an escape hatch. The
 * desktop puts a single Skip in the footer beside Send, and it is not a
 * dismiss: it submits, keeping answers already chosen and filling only the
 * blanks with `(skipped)`. A card with two of three answered and Skip pressed
 * sends those two.
 *
 * `send` is injected rather than reached for, so every behaviour here is
 * testable without mounting the panel.
 */
export function buildQuestionCard(
  questions: AskUserQuestion[],
  host: QuestionCardHost,
): HTMLElement {
  const card = document.createElement("div");
  card.className = "ask";
  const multi = questions.length > 1;
  const answers: string[] = questions.map(() => "");
  /** Option buttons per question, so the number-key shortcut can reach them. */
  const optionRows: HTMLButtonElement[][] = [];
  let sent = false;

  const header = document.createElement("div");
  header.className = "ask__header";
  header.textContent = multi
    ? `${questions.length} questions — answer all to continue`
    : "Question";
  card.append(header);

  /**
   * `Q: … A: …` once there is more than one question, which is exactly
   * `combineAnswers` on the desktop. Without it the model receives several
   * answers in a row with nothing saying which belongs to which.
   */
  const combine = () =>
    multi
      ? questions
          .map((q, i) => `Q: ${q.question}\nA: ${answers[i] || SKIP_ANSWER}`)
          .join("\n\n")
      : answers[0];

  /** The desktop's `questionText`: the question for one, a count for several. */
  const questionText = () =>
    multi ? `${questions.length} questions` : questions[0].question;

  const submit = () => {
    // Once, ever. Guarded rather than assumed: the card is removed from the
    // transcript by the host on send, but a second click could land first.
    if (sent) return;
    sent = true;
    host.send(questionText(), combine());
  };

  /**
   * Submit with the blanks filled in. NOT a dismiss — the desktop's Skip does
   * exactly this, and keeping the answers already given is the whole point:
   * pressing it on a card with two of three answered must send those two.
   */
  const skipRest = () => {
    for (let i = 0; i < answers.length; i += 1) {
      if (!answers[i].trim()) answers[i] = SKIP_ANSWER;
    }
    submit();
  };

  let sendButton: HTMLButtonElement | null = null;
  const refreshSend = () => {
    if (!sendButton) return;
    sendButton.disabled = answers.some((a) => !a.trim());
  };

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

    const rows: HTMLButtonElement[] = [];
    const picks: HTMLButtonElement[] = [];
    optionRows.push(picks);
    const custom = document.createElement("input");

    /**
     * `commit` is FALSE for typing, and that distinction is load-bearing.
     *
     * The fast path — one question, click an option, send — is about a
     * COMPLETED gesture. Typing is not one: every keystroke fires `input`, so
     * running the fast path here sent the answer on the first character, with
     * the rest of the sentence going nowhere. Enter commits a typed answer;
     * `input` only records it.
     */
    const choose = (
      value: string,
      chosen: HTMLElement | null,
      commit: boolean,
    ) => {
      answers[qi] = value;
      for (const r of rows) r.setAttribute("aria-selected", String(r === chosen));
      custom.classList.toggle("ask__custom--on", chosen === null && !!value);
      if (commit && !multi && value.trim()) {
        submit();
        return;
      }
      refreshSend();
    };

    (q.options ?? []).forEach((option, oi) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ask__option";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");

      // The number STATES the order rather than leaving it to be inferred from
      // position — which is the whole reason this is a list and not a wrap of
      // chips that reflow by text width.
      const num = document.createElement("span");
      num.className = "ask__option-num";
      num.textContent = String(oi + 1);
      const label = document.createElement("span");
      label.className = "ask__option-label";
      label.textContent = option;
      row.append(num, label);

      row.addEventListener("click", () => choose(option, row, true));
      rows.push(row);
      picks.push(row);
      list.append(row);
    });

    custom.type = "text";
    custom.className = "ask__custom";
    custom.placeholder = q.options?.length ? "Something else…" : "Your answer…";
    custom.setAttribute("aria-label", `Your answer to: ${q.question}`);
    custom.addEventListener("input", () => choose(custom.value, null, false));
    custom.addEventListener("keydown", (e) => {
      // Enter sends a single question, the way it sends the composer. With
      // several open it would send the others half-answered.
      if (e.key === "Enter" && !multi && custom.value.trim()) {
        e.preventDefault();
        submit();
      }
    });
    list.append(custom);

    block.append(list);
    card.append(block);
  });

  /*
   * The footer, `justify-between` like the desktop's: Skip on the left, Send on
   * the right.
   *
   * SKIP IS ALWAYS HERE. Send is not — a single question with options has none,
   * because clicking an option is already the whole answer and a button that
   * only ever confirms a thing already done is a button nobody presses. That is
   * the desktop's `multi || items[0].options.length === 0` condition.
   */
  const actions = document.createElement("div");
  actions.className = "ask__actions";

  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "ask__skip";
  skip.textContent = multi ? "Skip remaining" : "Skip";
  skip.addEventListener("click", skipRest);
  actions.append(skip);

  if (multi || (questions[0]?.options?.length ?? 0) === 0) {
    sendButton = document.createElement("button");
    sendButton.type = "button";
    sendButton.className = "button ask__send";
    sendButton.textContent = multi ? "Send answers" : "Send answer";
    sendButton.disabled = true;
    sendButton.addEventListener("click", submit);
    actions.append(sendButton);
  }
  card.append(actions);

  /*
   * NUMBER KEYS 1-4, for a single question — the desktop's shortcut
   * (`InlineUserQuestions.tsx:146-170`), including the guard that matters: a
   * keystroke while focus is in a field is someone TYPING an answer, not
   * picking one. The listener is on the card rather than the window, so a
   * scrolled-away question cannot swallow a "2" meant for the composer.
   */
  if (!multi && (questions[0]?.options?.length ?? 0) > 0) {
    card.addEventListener("keydown", (e) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      const index = Number(e.key) - 1;
      const row = optionRows[0]?.[index];
      if (!Number.isNaN(index) && row) {
        e.preventDefault();
        row.click();
      }
    });
  }

  return card;
}
