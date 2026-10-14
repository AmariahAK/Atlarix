/**
 * MCP servers Atlarix suggested for this chat, above the box: connect one
 * here (add it, sign in, paste a key) and Atlarix is told it can use it.
 * The app draws the same card; the CLI and other editors ask in a prompt.
 */
import { rpc } from "../rpc";
import { state } from "../state";
import { button, el } from "../ui";

export interface SuggestionCard {
  id: string;
  server: string;
  title: string;
  reason: string;
  verified: boolean;
  publisher: string;
  inputs: Array<{ key: string; label: string; secret: boolean; required: boolean; default?: string }>;
  optionId?: string;
}

interface Added {
  where: "account" | "local";
  id: string | number;
  name: string;
  needsSignIn: boolean;
  needsSecret?: { header: string | null };
}

export const suggestionsBox = el("div", "suggestions hidden");
const cards = new Map<string, SuggestionCard>();

const call = <T>(action: string, extra: Record<string, unknown>) =>
  rpc<T>("_atlarix/mcp", { sessionId: state.sessionId, action, ...extra });

export function showSuggestion(card: SuggestionCard): void {
  cards.set(card.id, card);
  draw();
}

export function removeSuggestion(id: string): void {
  cards.delete(id);
  draw();
}

export function clearSuggestions(): void {
  cards.clear();
  draw();
}

function draw(): void {
  suggestionsBox.textContent = "";
  suggestionsBox.classList.toggle("hidden", cards.size === 0);
  for (const card of cards.values()) suggestionsBox.append(cardView(card));
}

function cardView(card: SuggestionCard): HTMLElement {
  const box = el("div", "suggestion");
  const head = el("div", "suggestion__head");
  head.append(
    el("span", "muted small", "Recommended for you"),
    button("Not now", "link small", () => {
      void call("suggestDismiss", { id: card.id }).catch(() => {});
      removeSuggestion(card.id);
    }),
  );
  const body = el("div", "suggestion__body");
  const text = el("div", "col grow");
  const name = el("span", "");
  name.append(el("strong", "", card.title), el("span", "muted small", ` · ${card.verified ? "✓ Verified" : card.publisher}`));
  text.append(name);
  if (card.reason) text.append(el("span", "muted small", card.reason));
  const fields = new Map<string, HTMLInputElement>();
  for (const i of card.inputs) {
    const input = el("input", i.secret ? "field mono" : "field");
    if (i.secret) input.type = "password";
    input.placeholder = i.required ? i.label : `${i.label} (optional)`;
    if (i.default) input.value = i.default;
    fields.set(i.key, input);
    text.append(input);
  }
  const note = el("span", "small hidden");
  text.append(note);
  const say = (s: string, bad = false) => {
    note.textContent = s;
    note.classList.toggle("hidden", !s);
    note.classList.toggle("bad", bad);
  };
  const connect = button("Connect", "primary small", async () => {
    const values: Record<string, string> = {};
    for (const [k, input] of fields) if (input.value.trim()) values[k] = input.value.trim();
    const missing = card.inputs.find((i) => i.required && !values[i.key]);
    if (missing) return say(`${missing.label} is needed.`, true);
    connect.disabled = true;
    try {
      const { added } = await call<{ added: Added }>("suggestConnect", { id: card.id, optionId: card.optionId, values });
      if (added.needsSecret) return askKey(added);
      if (added.needsSignIn) {
        say(`Sign in to ${card.title} in your browser…`);
        if (added.where === "account") {
          const r = await call<{ result?: { ok: boolean; error?: string } }>("accountSignIn", { id: added.id });
          if (!r.result?.ok) {
            connect.disabled = false;
            return say(r.result?.error ?? "Sign-in didn't finish.", true);
          }
        } else {
          await call("oauth", { id: added.id });
        }
      }
      await finish(added.where === "local" && added.needsSignIn ? 5 * 60_000 : 0);
    } catch (x) {
      connect.disabled = false;
      say((x as Error).message, true);
    }
  });
  const finish = async (pollMs: number) => {
    const deadline = Date.now() + pollMs;
    for (;;) {
      const r = await call<{ result?: { connected: boolean; reason?: string } }>("suggestFinish", { id: card.id });
      if (r.result?.connected) return removeSuggestion(card.id);
      if (Date.now() >= deadline) {
        connect.disabled = false;
        return say(r.result?.reason ?? "Not connected yet.", true);
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
  };
  const askKey = (added: Added) => {
    for (const input of fields.values()) input.remove();
    const key = el("input", "field mono");
    key.type = "password";
    key.placeholder = added.needsSecret?.header ?? "API key";
    text.insertBefore(key, note);
    key.focus();
    connect.textContent = "Save";
    connect.disabled = false;
    connect.onclick = async () => {
      if (!key.value.trim()) return;
      connect.disabled = true;
      await call(added.where === "account" ? "accountSecret" : "setKey", { id: added.id, secret: key.value.trim() }).catch(
        (x: Error) => say(x.message, true),
      );
      await finish(0);
    };
  };
  body.append(text, connect);
  box.append(head, body);
  return box;
}
