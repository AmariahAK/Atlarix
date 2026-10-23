/** @jsxImportSource @opentui/react */
/**
 * Clickable links in the terminal: OSC 8, which OpenTUI writes for an `<a href>`
 * span. A terminal without OSC 8 shows the text, so where a link's label is not
 * its URL, the URL is printed after it unless the terminal says it can link
 * (`setTerminalHyperlinks`, from the renderer's capability query).
 */
import type { ReactNode } from "react";
import { color } from "./theme";
import { oneLine } from "./format";
import { URL_IN_TEXT } from "@/lib/text/urls";

let hyperlinks = false;

/** What the terminal answered about OSC 8 (App, on the renderer's capabilities). */
export function setTerminalHyperlinks(on: boolean): void {
  hyperlinks = on;
}

export function terminalHyperlinks(): boolean {
  return hyperlinks;
}

/** A link: its label clickable, and its URL beside it where the terminal cannot link. */
export function Link({ href, label, fg = color.accent }: { href: string; label: string; fg?: string }): ReactNode {
  const showUrl = !hyperlinks && href !== label && !href.startsWith("#");
  return (
    <>
      <a href={href} fg={fg}>
        {label}
      </a>
      {showUrl ? <span fg={color.muted}>{` (${href})`}</span> : null}
    </>
  );
}

/** Plain text with every http(s) URL in it made clickable (inside a `<text>`). */
export function linkify(text: string, fg?: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <a key={`${at}`} href={m[0]} fg={fg ?? color.accent}>
        {m[0]}
      </a>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length ? out : [text];
}

/**
 * One line cut to `max`, keeping a URL in it whole: a dev server's
 * "Local: http://localhost:5173/" cut before its port is the one line that
 * mattered. The text before the URL gives way first.
 */
export function oneLineKeepingUrl(text: string, max: number): string {
  const first = oneLine(text, Number.MAX_SAFE_INTEGER).replace(/…$/, "");
  if (first.length <= max) return oneLine(text, max);
  const m = [...first.matchAll(URL_IN_TEXT)][0];
  if (!m) return oneLine(text, max);
  const url = m[0];
  if (url.length + 2 > max) return url;
  const before = first.slice(0, m.index).trimEnd();
  const room = max - url.length - 1;
  return `${before.length > room ? `${before.slice(0, Math.max(0, room - 1)).trimEnd()}…` : before} ${url}`.trimStart();
}
