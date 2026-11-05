/**
 * The wrapped form of a message from another Atlarix session (see peers.ts):
 * built in main, parsed by the app's transcript and the CLI's. No Node imports,
 * so the renderer can use it.
 */

export interface PeerFrom {
  sessionId: string;
  name: string;
  surface: "cli" | "app" | "chrome" | "editor";
  workspace: string;
}

/** Where a turn of a session is running, in "Running in …" (live sessions). */
export const SURFACE_NAMES = { app: "the app", cli: "the CLI", editor: "the editor", chrome: "the browser" } as const;

/** How a surface reads in "Message from X session": CLI, app, browser or editor. */
export function peerSurfaceLabel(surface: string): string {
  return surface === "cli"
    ? "CLI"
    : surface === "chrome"
      ? "browser"
      : surface === "editor"
        ? "editor"
        : "app";
}

/** How much of a peer message its row shows before "expand" (Claude Code's pattern). */
export const PEER_PREVIEW_CHARS = 120;

/** A card (app, editor, browser) shows a message whole up to this long; past it, the preview and expand. */
export const PEER_FOLD_CHARS = 600;

/**
 * The row for a message from another session: "Message from <name> (<surface>)".
 * Every surface uses it, so the label reads the same in the app, CLI and editors.
 */
export function peerRowLabel(from: string, surface: string): string {
  return `Message from ${from || "another session"} (${peerSurfaceLabel(surface)})`;
}

/**
 * What a peer message's row shows inline: its text with the lines joined (a
 * short first line like "ai-4b:" hid the rest), cut near `max` at a word with
 * "…". `more`: there is more to see on expand (it was cut, or it has lines).
 */
export function peerPreview(text: string, max = PEER_PREVIEW_CHARS): { text: string; more: boolean } {
  const trimmed = text.trim();
  const flat = trimmed.replace(/\s+/g, " ");
  const lines = /\n/.test(trimmed);
  if (flat.length <= max) return { text: flat, more: lines };
  let cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  if (space > max * 0.6) cut = cut.slice(0, space);
  return { text: `${cut.replace(/[\s,;:.-]+$/, "")}…`, more: true };
}

/**
 * The receiver's name in send_message's own result ("Sent to NAME (CLI, …" or
 * "Delivered to NAME. It starts …", lib/tools/peers.ts), raw or in its JSON
 * envelope. Null when it isn't one: the row then keeps what `to` said.
 */
export function sentToName(result: string | undefined | null): string | null {
  if (!result) return null;
  let text = result;
  try {
    const v = JSON.parse(result) as { text?: unknown };
    if (v && typeof v.text === "string") text = v.text;
  } catch {
    /* plain text */
  }
  const m =
    /^Sent to (.+?) \((?:CLI|app|browser|editor)[,)]/.exec(text) ??
    /^Delivered to (.+?)\. It starts\b/.exec(text);
  return m?.[1]?.trim() || null;
}

function attr(value: string): string {
  return value.replace(
    /[&"<>]/g,
    (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!,
  );
}

/**
 * Wrap a peer's text so the model and the UI can tell it from the user's.
 * `notice`: a one-way notice (a "turn ended" line) — marked so the model knows
 * it asks for nothing.
 */
export function wrapPeerMessage(from: PeerFrom, text: string, opts: { notice?: boolean } = {}): string {
  // The body cannot close the tag early and smuggle text out as "the user's".
  const body = text.replace(/<\/?atlarix-peer-message[^>]*>/gi, "");
  return (
    `<atlarix-peer-message from="${attr(from.name)}" reply-to="${attr(from.sessionId)}" ` +
    `surface="${from.surface}" workspace="${attr(from.workspace)}"${opts.notice ? ' kind="notice"' : ""}>\n${body}\n</atlarix-peer-message>`
  );
}

/** The parts of a wrapped message, for the UI chip / the CLI notice. Null when it isn't one. */
export function parsePeerMessage(content: string): {
  from: string;
  replyTo: string;
  surface: string;
  workspace: string;
  text: string;
} | null {
  const m =
    /^\s*<atlarix-peer-message([^>]*)>\n?([\s\S]*?)\n?<\/atlarix-peer-message>\s*$/.exec(
      content,
    );
  if (!m) return null;
  const a = (name: string) =>
    (new RegExp(`${name}="([^"]*)"`).exec(m[1]!)?.[1] ?? "")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  return {
    from: a("from"),
    replyTo: a("reply-to"),
    surface: a("surface"),
    workspace: a("workspace"),
    text: m[2]!,
  };
}

export type PeerSegment =
  | {
      kind: "peer";
      from: string;
      replyTo: string;
      surface: string;
      workspace: string;
      text: string;
    }
  | { kind: "text"; text: string };

/**
 * A user row split into the peer messages in it and any other text. Several
 * messages queued while a session was idle open ONE turn, joined, so a row can
 * hold more than one. Null when the row holds none.
 */
export function splitPeerMessages(content: string): PeerSegment[] | null {
  if (!content.includes("<atlarix-peer-message")) return null;
  const out: PeerSegment[] = [];
  const re = /<atlarix-peer-message[^>]*>[\s\S]*?<\/atlarix-peer-message>/g;
  let last = 0;
  for (const m of content.matchAll(re)) {
    const before = content.slice(last, m.index).trim();
    if (before) out.push({ kind: "text", text: before });
    const parsed = parsePeerMessage(m[0]);
    if (parsed) out.push({ kind: "peer", ...parsed });
    last = m.index! + m[0].length;
  }
  const rest = content.slice(last).trim();
  if (rest) out.push({ kind: "text", text: rest });
  return out.some((s) => s.kind === "peer") ? out : null;
}

/**
 * Format a queued message for display in the composer's pending list.
 * If it's a peer message, show "From [name]: [first ~80 chars]..." instead of raw XML.
 */
export function formatPeerMessagePreview(text: string, maxLen = 80): string {
  const parsed = parsePeerMessage(text);
  if (!parsed) return text;
  const preview = parsed.text.slice(0, maxLen).replace(/\n/g, " ");
  const ellipsis = parsed.text.length > maxLen ? "..." : "";
  return `From ${parsed.from}: ${preview}${ellipsis}`;
}
