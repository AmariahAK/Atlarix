/**
 * "How is Atlarix doing this session?" above the box, when the agent says it
 * is due (after a few turns, once a session, days apart on every surface:
 * lib/feedback/session-rating.ts), then "What should we improve?". The CLI
 * asks the same in its own row; any editor takes /feedback.
 */
import { rpc } from "../rpc";
import { state } from "../state";
import { button, el, icon } from "../ui";

export const ratingBox = el("div", "suggestions hidden");

const QUESTION = "How is Atlarix doing this session?";
const SENDS = "Sends your rating, Atlarix version, model, mode and session length. Never your code or prompts.";

function close(): void {
  ratingBox.textContent = "";
  ratingBox.classList.add("hidden");
}

/** After a turn: ask if it is due. */
export async function maybeAskRating(): Promise<void> {
  const sessionId = state.sessionId;
  if (!sessionId || !ratingBox.classList.contains("hidden")) return;
  const r = await rpc<{ ask: boolean }>("_atlarix/rating_due", { sessionId }).catch(() => null);
  if (r?.ask && state.sessionId === sessionId) ask(sessionId);
}

/** Another chat opened: this one's question goes with it. */
export function clearRating(): void {
  close();
}

function card(title: string, onClose: () => void): { box: HTMLElement; body: HTMLElement } {
  const box = el("div", "suggestion");
  const head = el("div", "suggestion__head");
  const x = button("", "icon small", onClose, "Dismiss");
  x.innerHTML = icon("close", 13);
  head.append(el("span", "", title), x);
  const body = el("div", "suggestion__body col");
  box.append(head, body);
  return { box, body };
}

function ask(sessionId: string): void {
  const rate = (rating: number) => {
    void rpc("_atlarix/rate", { sessionId, rating }).catch(() => {});
    if (rating === 0) close();
    else improve(sessionId);
  };
  const { box, body } = card(QUESTION, () => rate(0));
  const row = el("div", "mcp__actions");
  for (const [n, label] of [
    [1, "1 Bad"],
    [2, "2 Fine"],
    [3, "3 Good"],
  ] as const) {
    row.append(button(label, "small", () => rate(n)));
  }
  body.append(row, el("span", "muted small", SENDS));
  ratingBox.textContent = "";
  ratingBox.append(box);
  ratingBox.classList.remove("hidden");
}

function improve(sessionId: string): void {
  const { box, body } = card("What should we improve?", close);
  const text = el("textarea", "field");
  text.rows = 3;
  text.maxLength = 2000;
  text.placeholder = "Optional";
  const note = el("span", "muted small");
  const send = button("Send", "primary small", () => {
    const words = text.value.trim();
    if (!words) return close();
    send.disabled = true;
    void rpc<{ ok: boolean }>("_atlarix/feedback", { sessionId, text: words })
      .catch(() => ({ ok: false }))
      .then((r) => {
        send.disabled = false;
        // What you typed stays in the box until it is sent.
        if (!r.ok) return void (note.textContent = "Couldn't send that. Try again later.");
        body.textContent = "";
        body.append(el("span", "muted small", "Thanks. That helps us make Atlarix better."));
        setTimeout(close, 3000);
      });
  });
  const row = el("div", "mcp__actions");
  row.append(send, button("Skip", "small", close));
  body.append(text, row, note);
  ratingBox.textContent = "";
  ratingBox.append(box);
  ratingBox.classList.remove("hidden");
  text.focus();
}
