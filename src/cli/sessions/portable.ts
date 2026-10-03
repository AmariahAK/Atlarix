/**
 * A conversation outside Atlarix: what `/export` writes and `/import` reads.
 *
 * One shape for every direction — an Atlarix export, a Claude Code session, a
 * Codex rollout, an opencode session all become a `PortableSession` — so each
 * importer only has to read its own format, and writing it back into Atlarix
 * is one function. Tools are kept as what was done ("Read src/a.ts"), not as
 * replayable calls: another tool's calls are not Atlarix's to re-run, and the
 * next model only needs to know they happened.
 *
 * Pure (src/__tests__/cli-portable-session.test.ts).
 */
import { toCells, type ChatMessageLike } from "../agent/transcript";

export interface PortableTool {
  name: string;
  target?: string;
  /** A short result: the first lines of output, or the error. */
  result?: string;
  failed?: boolean;
}

export interface PortableMessage {
  role: "user" | "assistant";
  text: string;
  tools?: PortableTool[];
}

export interface PortableSession {
  format: "atlarix-session";
  version: 1;
  title: string;
  /** Where it came from: atlarix, claude-code, codex, opencode. */
  source: string;
  workspace: string;
  exportedAt: string;
  model?: string;
  messages: PortableMessage[];
}

const RESULT_LINES = 6;

function shortResult(text: string | undefined): string | undefined {
  const t = (text ?? "").trim();
  if (!t) return undefined;
  const lines = t.split("\n");
  return lines.slice(0, RESULT_LINES).join("\n") + (lines.length > RESULT_LINES ? `\n… ${lines.length - RESULT_LINES} more lines` : "");
}

/** This session's messages (as the agent has them) as a portable session. */
export function fromAtlarixMessages(
  messages: readonly ChatMessageLike[],
  meta: { title: string | null; workspace: string; model?: string; now?: Date },
): PortableSession {
  const out: PortableMessage[] = [];
  let current: PortableMessage | null = null;
  for (const cell of toCells(messages)) {
    if (cell.kind === "user") {
      current = null;
      out.push({ role: "user", text: cell.text });
      continue;
    }
    if (cell.kind === "thought" || cell.kind === "notice") continue;
    if (!current) {
      current = { role: "assistant", text: "", tools: [] };
      out.push(current);
    }
    if (cell.kind === "markdown") current.text = current.text ? `${current.text}\n\n${cell.text}` : cell.text;
    else if (cell.kind === "tool") {
      current.tools!.push({
        name: cell.tool.verb,
        target: cell.tool.target || undefined,
        result: shortResult(cell.tool.error ?? cell.tool.output ?? cell.tool.summary),
        failed: cell.tool.status === "error" || undefined,
      });
    }
  }
  for (const m of out) if (m.tools && m.tools.length === 0) delete m.tools;
  return {
    format: "atlarix-session",
    version: 1,
    title: meta.title?.trim() || firstLine(out.find((m) => m.role === "user")?.text) || "Atlarix session",
    source: "atlarix",
    workspace: meta.workspace,
    exportedAt: (meta.now ?? new Date()).toISOString(),
    ...(meta.model ? { model: meta.model } : {}),
    messages: out,
  };
}

export function firstLine(text: string | undefined, max = 60): string {
  const line = (text ?? "").trim().split("\n")[0]?.trim() ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/** Markdown for a person to read (the default /export). */
export function toMarkdown(s: PortableSession): string {
  const parts = [`# ${s.title}`, "", `_Exported from Atlarix · ${s.workspace} · ${s.exportedAt.slice(0, 10)}_`];
  for (const m of s.messages) {
    parts.push("", m.role === "user" ? "## You" : "## Atlarix", "");
    if (m.tools?.length) {
      for (const t of m.tools) parts.push(`- ${t.failed ? "✗" : "●"} ${t.name}${t.target ? ` \`${t.target}\`` : ""}`);
      parts.push("");
    }
    if (m.text) parts.push(m.text);
  }
  return parts.join("\n").trimEnd() + "\n";
}

/** The message text an imported assistant turn gets: what it did, then what it said. */
export function messageContent(m: PortableMessage): string {
  if (m.role === "user" || !m.tools?.length) return m.text;
  const done = m.tools.map((t) => `${t.failed ? "✗" : "●"} ${t.name}${t.target ? ` ${t.target}` : ""}`).join("\n");
  return [done, m.text].filter(Boolean).join("\n\n");
}

/** A parsed file, if it is one of ours. */
export function parsePortable(raw: string): PortableSession | null {
  try {
    const j = JSON.parse(raw) as Partial<PortableSession>;
    if (j.format !== "atlarix-session" || j.version !== 1 || !Array.isArray(j.messages)) return null;
    return j as PortableSession;
  } catch {
    return null;
  }
}

// ─── --sanitize ──────────────────────────────────────────────────────────────

const KEY_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style, Anthropic sk-ant-…
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
];
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** For sharing: the home folder, email addresses and key-shaped strings replaced. */
export function sanitize(text: string, home: string): string {
  let out = home ? text.split(home).join("~") : text;
  for (const re of KEY_SHAPES) out = out.replace(re, "[redacted key]");
  return out.replace(EMAIL, "[email]");
}

export function sanitizeSession(s: PortableSession, home: string): PortableSession {
  const clean = (t: string | undefined) => (t == null ? t : sanitize(t, home));
  return {
    ...s,
    title: clean(s.title)!,
    workspace: clean(s.workspace)!,
    messages: s.messages.map((m) => ({
      ...m,
      text: clean(m.text)!,
      ...(m.tools ? { tools: m.tools.map((t) => ({ ...t, target: clean(t.target), result: clean(t.result) })) } : {}),
    })),
  };
}

/** `atlarix-<slug>-<date>.md` */
export function exportFileName(title: string, ext: "md" | "json", now = new Date()): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "session";
  return `atlarix-${slug}-${now.toISOString().slice(0, 10)}.${ext}`;
}
