/**
 * Relics — self-contained documents the model builds for you.
 *
 * A relic is one HTML file: a chart, a table, a calculator, a formatted
 * write-up. It is the thing that used to arrive as a hundred-line code block
 * you had to copy somewhere to see.
 *
 * WHERE IT RUNS, AND WHY THAT IS THE WHOLE DESIGN. The HTML is written by a
 * model whose input is pages the agent has read, so it is untrusted in the
 * strongest sense: a page could talk the model into writing anything. It
 * therefore never runs in an extension page — the one context holding the
 * user's session, their site grants and the `chrome.*` namespace. It runs in a
 * page declared under the manifest's `sandbox` key, which Chrome gives an
 * OPAQUE ORIGIN, no extension API access, and no same-origin handle back. The
 * only channel is `postMessage`.
 *
 * `panel/markdown.ts` refuses `innerHTML` for exactly this threat. This is the
 * other half of that argument rather than an exception to it: the answer is not
 * "render model HTML in our page carefully", it is "render it somewhere that
 * has nothing to steal".
 *
 * THE SANDBOX CSP ALSO CUTS THE NETWORK — `connect-src 'none'`. A relic is a
 * document, not a client. Without that, a page could get the model to write a
 * relic that fetches whatever the user pasted into the conversation to an
 * address of its choosing, and the sandbox would not stop it: an opaque origin
 * protects US from the relic, not the user from exfiltration.
 *
 * SESSION-SCOPED, like attachments, so a relic dies with the conversation that
 * produced it and cannot be read from another one. Same reasoning as
 * `attachments/store.ts`: lifetime and scope both become a key prefix rather
 * than a rule someone has to remember at a call site.
 */

import { api } from "../shared/browser-api";

const PREFIX = "atlarix.relic.";
const keyFor = (sessionId: string, id: string) =>
  `${PREFIX}${sessionId}.${id}.v1`;

/**
 * The largest relic we will store.
 *
 * A self-contained document with its own styles and a chart library inlined is
 * a few hundred kilobytes. Past this it is not a document any more, and the
 * model should be told so while it can still do something about it.
 */
export const MAX_RELIC_BYTES = 2 * 1024 * 1024;

export interface Relic {
  id: string;
  title: string;
  html: string;
  createdAt: number;
}

function isRelic(v: unknown): v is Relic {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.title === "string" &&
    typeof r.html === "string" &&
    typeof r.createdAt === "number"
  );
}

/**
 * A short, unguessable id.
 *
 * NOT a content hash, unlike an attachment's. Two relics with the same body are
 * two relics — the model rebuilding a chart after a correction should not
 * silently overwrite the one already on screen and open the old title.
 */
function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export async function putRelic(
  sessionId: string,
  relic: { title: string; html: string },
): Promise<string> {
  const id = newId();
  const record: Relic = {
    id,
    title: relic.title,
    html: relic.html,
    createdAt: Date.now(),
  };
  await api().storage.local.set({ [keyFor(sessionId, id)]: record });
  return id;
}

export async function getRelic(
  sessionId: string,
  id: string,
): Promise<Relic | null> {
  // The id is interpolated into a storage key, so a malformed one must not
  // become a lookup for something else. Ids we mint are hex.
  if (!/^[0-9a-f]{1,64}$/.test(id)) return null;
  try {
    const key = keyFor(sessionId, id);
    const bag = await api().storage.local.get<Record<string, unknown>>(key);
    const raw = bag?.[key];
    return isRelic(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Forget every relic made in these conversations. */
export async function deleteSessionRelics(
  sessionIds: string[],
): Promise<void> {
  if (sessionIds.length === 0) return;
  try {
    const bag = await api().storage.local.get<Record<string, unknown>>(null);
    const prefixes = sessionIds.map((id) => `${PREFIX}${id}.`);
    const doomed = Object.keys(bag ?? {}).filter((k) =>
      prefixes.some((p) => k.startsWith(p)),
    );
    if (doomed.length > 0) await api().storage.local.remove(doomed);
  } catch {
    // A conversation that could not be tidied is a quota cost, not a failure
    // the user can act on. Never throw out of a delete.
  }
}

/**
 * The address of a relic's viewer.
 *
 * `relic.html` is an ORDINARY extension page — it has `chrome.storage` and so
 * can fetch the body — and it hosts the sandboxed frame that actually runs it.
 * The session id travels in the URL because the viewer is a separate document
 * with no other way to know which conversation it belongs to; it is a lookup
 * key inside this profile, not a secret.
 */
export function relicUrl(sessionId: string, id: string): string {
  const params = new URLSearchParams({ session: sessionId, id });
  return api().runtime.getURL(`relic.html?${params.toString()}`);
}

/**
 * Resources a relic points at that the sandbox will refuse to load.
 *
 * CHECKED BEFORE SAVING, not diagnosed after. A relic whose UI is built by a
 * script from a CDN renders a BLANK WHITE PAGE — the document loads, the script
 * is blocked, and nothing ever draws. There is no error the user can act on and
 * nothing on screen to suggest what went wrong; it simply looks broken.
 *
 * Refusing at creation turns that into a sentence the model reads while it can
 * still do something about it, on the turn it made the mistake.
 *
 * Only SCRIPTS and STYLESHEETS, which take the whole document down with them.
 * An external image renders as a broken image next to content that is otherwise
 * fine, and the viewer's own notice covers it — refusing a relic over a logo
 * would be worse than showing it.
 */
export function externalResources(html: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /<script\b[^>]*\bsrc\s*=\s*["']?(https?:)?\/\/[^"'\s>]+/gi,
    /<link\b[^>]*\bhref\s*=\s*["']?(https?:)?\/\/[^"'\s>]+/gi,
    /@import\s+(?:url\()?["']?(https?:)?\/\/[^"'\s)]+/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const url = /(?:(?:https?:)?\/\/)[^"'\s>)]+/.exec(match[0])?.[0];
      if (url) found.add(url);
    }
  }
  return [...found];
}

/**
 * What the model is told when a relic is saved — and how the panel finds it
 * again after a reload.
 *
 * ONE DEFINITION FOR BOTH DIRECTIONS, the same rule as `attachedTextPart` and
 * `readAttachedText`. A relic is not part of the transcript — only this tool
 * result is — so on reopening a conversation the id has to come from somewhere,
 * and the only durable somewhere is the result text itself.
 *
 * Which means the wording IS a contract, and that is worth stating plainly
 * rather than discovering: change this sentence and every relic in every saved
 * conversation stops being openable. The round trip has a test.
 */
const NOTE = /^Saved "([\s\S]*)" as a relic \[id ([0-9a-f]+)\]\./;

export function relicNote(id: string, title: string): string {
  return (
    `Saved "${title}" as a relic [id ${id}]. The user has it in this ` +
    `conversation and can open it. Do not repeat its HTML in your reply — say ` +
    `what it shows and what you would change.`
  );
}

/** A relic out of a stored tool result, or null when it is some other result. */
export function readRelicNote(
  content: string,
): { id: string; title: string } | null {
  const match = NOTE.exec(content);
  return match ? { id: match[2], title: match[1] } : null;
}
