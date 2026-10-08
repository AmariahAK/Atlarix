/**
 * The wrapped form of a message from another Atlarix session (see peers.ts):
 * built in main, parsed by the app's transcript and the CLI's. No Node imports,
 * so the renderer can use it.
 */

export interface PeerFrom {
  sessionId: string;
  name: string;
  surface: "cli" | "app" | "chrome";
  workspace: string;
}

/** How a surface reads in "Message from X session": CLI, app or browser. */
export function peerSurfaceLabel(surface: string): string {
  return surface === "cli" ? "CLI" : surface === "chrome" ? "browser" : "app";
}

function attr(value: string): string {
  return value.replace(
    /[&"<>]/g,
    (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!,
  );
}

/** Wrap a peer's text so the model and the UI can tell it from the user's. */
export function wrapPeerMessage(from: PeerFrom, text: string): string {
  // The body cannot close the tag early and smuggle text out as "the user's".
  const body = text.replace(/<\/?atlarix-peer-message[^>]*>/gi, "");
  return (
    `<atlarix-peer-message from="${attr(from.name)}" reply-to="${attr(from.sessionId)}" ` +
    `surface="${from.surface}" workspace="${attr(from.workspace)}">\n${body}\n</atlarix-peer-message>`
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
