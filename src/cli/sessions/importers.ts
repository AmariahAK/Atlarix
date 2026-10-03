/**
 * `/import --from claude|codex|opencode`: the sessions another coding agent
 * kept for THIS folder, read from where that tool keeps them, as portable
 * sessions (portable.ts). Read-only: nothing in the other tool changes.
 *
 *   Claude Code  ~/.claude/projects/<folder, non-alphanumerics as "-">/*.jsonl
 *   Codex        ~/.codex/sessions/**\/rollout-*.jsonl (session_meta.cwd)
 *   opencode     ~/.local/share/opencode/opencode.db (session/message/part)
 *
 * The parsers take lines / rows, so they are tested without the tools
 * installed (src/__tests__/cli-importers.test.ts); only the listing touches disk.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAppPath } from "@/lib/canonical-app-path";
import { firstLine, type PortableMessage, type PortableSession, type PortableTool } from "./portable";

export type ImportSource = "claude" | "codex" | "opencode";

export const SOURCE_NAMES: Record<ImportSource, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "opencode",
};

export interface ForeignSession {
  source: ImportSource;
  id: string;
  title: string;
  updatedAt: number;
  /** Load it in full. */
  load: () => PortableSession;
}

const MAX_RESULT = 400;

function clip(text: unknown): string | undefined {
  const t = typeof text === "string" ? text : Array.isArray(text) ? text.map((x) => (x as { text?: string })?.text ?? "").join("\n") : "";
  const s = t.trim();
  if (!s) return undefined;
  return s.length > MAX_RESULT ? s.slice(0, MAX_RESULT) + "…" : s;
}

function toolTargetFrom(input: unknown): string | undefined {
  const a = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  for (const k of ["file_path", "path", "filePath", "pattern", "command", "cmd", "url", "query", "description"]) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) return firstLine(v, 80);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return firstLine(v.join(" "), 80);
  }
  return undefined;
}

function session(source: ImportSource, title: string, workspace: string, messages: PortableMessage[], model?: string): PortableSession {
  return {
    format: "atlarix-session",
    version: 1,
    title: title || firstLine(messages.find((m) => m.role === "user")?.text) || `${SOURCE_NAMES[source]} session`,
    source: source === "claude" ? "claude-code" : source,
    workspace,
    exportedAt: new Date().toISOString(),
    ...(model ? { model } : {}),
    messages: messages.filter((m) => m.text.trim() || m.tools?.length),
  };
}

/** Adds to the last assistant message, or starts one. */
function assistant(out: PortableMessage[]): PortableMessage {
  const last = out.at(-1);
  if (last?.role === "assistant") return last;
  const m: PortableMessage = { role: "assistant", text: "", tools: [] };
  out.push(m);
  return m;
}

function appendText(m: PortableMessage, text: string): void {
  const t = text.trim();
  if (t) m.text = m.text ? `${m.text}\n\n${t}` : t;
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

/** Claude Code's project folder name for a path. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function parseClaudeCode(lines: string[], workspace: string): PortableSession {
  const out: PortableMessage[] = [];
  const pending = new Map<string, PortableTool>();
  let title = "";
  let model: string | undefined;
  for (const line of lines) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type === "ai-title" && typeof d.aiTitle === "string") title = d.aiTitle;
    if (d.isSidechain || d.isMeta) continue;
    const msg = d.message as { role?: string; content?: unknown; model?: string } | undefined;
    if (!msg) continue;
    if (d.type === "user") {
      if (typeof msg.content === "string") {
        // Commands and their output are recorded as tagged user text.
        if (/^<(command-|local-command-|system-reminder)/.test(msg.content.trim())) continue;
        out.push({ role: "user", text: msg.content.trim() });
      } else if (Array.isArray(msg.content)) {
        for (const c of msg.content as Array<Record<string, unknown>>) {
          if (c.type === "tool_result") {
            const tool = pending.get(String(c.tool_use_id));
            if (tool) {
              tool.result = clip(c.content);
              if (c.is_error) tool.failed = true;
            }
          } else if (c.type === "text" && typeof c.text === "string" && !/^<system-reminder/.test(c.text.trim())) {
            out.push({ role: "user", text: c.text.trim() });
          }
        }
      }
    } else if (d.type === "assistant" && Array.isArray(msg.content)) {
      model ??= msg.model;
      const m = assistant(out);
      for (const c of msg.content as Array<Record<string, unknown>>) {
        if (c.type === "text" && typeof c.text === "string") appendText(m, c.text);
        else if (c.type === "tool_use") {
          const tool: PortableTool = { name: String(c.name ?? "tool"), target: toolTargetFrom(c.input) };
          m.tools!.push(tool);
          pending.set(String(c.id), tool);
        }
      }
    }
  }
  return session("claude", title, workspace, out, model);
}

// ─── Codex ───────────────────────────────────────────────────────────────────

export function parseCodex(lines: string[]): PortableSession & { cwd: string } {
  const out: PortableMessage[] = [];
  const pending = new Map<string, PortableTool>();
  let cwd = "";
  let model: string | undefined;
  for (const line of lines) {
    let d: { type?: string; payload?: Record<string, unknown> };
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const p = d.payload ?? {};
    if (d.type === "session_meta") cwd = String(p.cwd ?? "");
    else if (d.type === "turn_context") model ??= typeof p.model === "string" ? p.model : undefined;
    else if (d.type === "event_msg" && p.type === "user_message" && typeof p.message === "string") {
      // The user's own words. (response_item user messages also carry the
      // environment context Codex injects.)
      out.push({ role: "user", text: p.message.trim() });
    } else if (d.type === "response_item") {
      if (p.type === "message" && p.role === "assistant" && Array.isArray(p.content)) {
        const text = (p.content as Array<{ type?: string; text?: string }>)
          .filter((c) => c.type === "output_text")
          .map((c) => c.text ?? "")
          .join("\n");
        appendText(assistant(out), text);
      } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
        let args: unknown = p.arguments ?? p.input ?? p.action;
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            /* a raw string */
          }
        }
        const tool: PortableTool = {
          name: String(p.name ?? (p.type === "local_shell_call" ? "shell" : "tool")),
          target: typeof args === "string" ? firstLine(args, 80) : toolTargetFrom(args),
        };
        assistant(out).tools!.push(tool);
        pending.set(String(p.call_id ?? p.id ?? ""), tool);
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        const tool = pending.get(String(p.call_id ?? ""));
        const o = p.output;
        if (tool) tool.result = clip(typeof o === "string" ? o : (o as { content?: string })?.content);
      }
    }
  }
  const s = session("codex", "", cwd, out, model);
  return { ...s, cwd };
}

// ─── opencode ────────────────────────────────────────────────────────────────

export interface OpencodeRows {
  session: { id: string; title: string; directory: string; model?: string | null };
  messages: Array<{ id: string; data: string }>;
  parts: Array<{ message_id: string; data: string }>;
}

export function parseOpencode(rows: OpencodeRows): PortableSession {
  const out: PortableMessage[] = [];
  const partsBy = new Map<string, Array<Record<string, unknown>>>();
  for (const p of rows.parts) {
    try {
      partsBy.set(p.message_id, [...(partsBy.get(p.message_id) ?? []), JSON.parse(p.data)]);
    } catch {
      /* skip */
    }
  }
  for (const m of rows.messages) {
    let info: { role?: string };
    try {
      info = JSON.parse(m.data);
    } catch {
      continue;
    }
    const parts = partsBy.get(m.id) ?? [];
    if (info.role === "user") {
      const text = parts
        .filter((p) => p.type === "text" && !p.synthetic)
        .map((p) => String(p.text ?? ""))
        .join("\n")
        .trim();
      if (text) out.push({ role: "user", text });
    } else if (info.role === "assistant") {
      const a = assistant(out);
      for (const p of parts) {
        if (p.type === "text") appendText(a, String(p.text ?? ""));
        else if (p.type === "tool") {
          const state = (p.state ?? {}) as { input?: unknown; output?: unknown; error?: unknown; status?: string };
          a.tools!.push({
            name: String(p.tool ?? "tool"),
            target: toolTargetFrom(state.input),
            result: clip(state.error ?? state.output),
            ...(state.status === "error" ? { failed: true } : {}),
          });
        }
      }
    }
  }
  return session("opencode", rows.session.title, rows.session.directory, out, rows.session.model ?? undefined);
}

// ─── listing for a folder ────────────────────────────────────────────────────

const samePath = (a: string, b: string) => normalizeAppPath(a) === normalizeAppPath(b);

function readLines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
}

export function listClaudeSessions(cwd: string, home = os.homedir()): ForeignSession[] {
  const root = path.join(home, ".claude", "projects");
  const want = claudeProjectDirName(cwd).toLowerCase();
  let dirs: string[] = [];
  try {
    // Case-insensitively: macOS paths keep whatever case they were typed in.
    dirs = fs.readdirSync(root).filter((d) => d.toLowerCase() === want);
  } catch {
    return [];
  }
  return dirs.flatMap((d) =>
    fs
      .readdirSync(path.join(root, d))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const file = path.join(root, d, f);
        const head = readHead(file, 64 * 1024);
        const titled = head.match(/"aiTitle"\s*:\s*"([^"]+)"/)?.[1];
        const firstUser = head.match(/"type":"user"[^\n]*?"content":"((?:[^"\\]|\\.)*)"/)?.[1];
        return {
          source: "claude" as const,
          id: f.replace(/\.jsonl$/, ""),
          title: titled ?? firstLine(firstUser ? JSON.parse(`"${firstUser}"`) : "", 60) ?? "",
          updatedAt: fs.statSync(file).mtimeMs,
          load: () => parseClaudeCode(readLines(file), cwd),
        };
      }),
  );
}

function readHead(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

export function listCodexSessions(cwd: string, home = os.homedir()): ForeignSession[] {
  return walk(path.join(home, ".codex", "sessions")).flatMap((file) => {
    const head = readHead(file, 16 * 1024).split("\n");
    let meta: { cwd?: string } = {};
    try {
      meta = (JSON.parse(head[0] ?? "") as { payload?: { cwd?: string } }).payload ?? {};
    } catch {
      return [];
    }
    if (!meta.cwd || !samePath(meta.cwd, cwd)) return [];
    const firstUser = head
      .map((l) => {
        try {
          const d = JSON.parse(l) as { type?: string; payload?: { type?: string; message?: string } };
          return d.type === "event_msg" && d.payload?.type === "user_message" ? d.payload.message : undefined;
        } catch {
          return undefined;
        }
      })
      .find(Boolean);
    return [
      {
        source: "codex" as const,
        id: path.basename(file, ".jsonl"),
        title: firstLine(firstUser ?? "", 60) || "Codex session",
        updatedAt: fs.statSync(file).mtimeMs,
        load: () => parseCodex(readLines(file)),
      },
    ];
  });
}

/**
 * opencode keeps its sessions in SQLite. Read read-only through better-sqlite3's
 * API, which the CLI binary serves from bun:sqlite (scripts/bun-cli-plugin.ts).
 */
export async function listOpencodeSessions(cwd: string, home = os.homedir()): Promise<ForeignSession[]> {
  const file = path.join(home, ".local", "share", "opencode", "opencode.db");
  if (!fs.existsSync(file)) return [];
  const { default: Database } = await import("better-sqlite3");
  const open = () => new Database(file, { readonly: true, fileMustExist: true });
  const db = open();
  try {
    const sessions = db
      .prepare("SELECT id, title, directory, model, time_updated FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC")
      .all() as Array<{ id: string; title: string; directory: string; model: string | null; time_updated: number }>;
    return sessions
      .filter((s) => samePath(s.directory, cwd))
      .map((s) => ({
        source: "opencode" as const,
        id: s.id,
        title: s.title,
        updatedAt: s.time_updated,
        load: () => {
          const conn = open();
          try {
            return parseOpencode({
              session: s,
              messages: conn.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id").all(s.id) as OpencodeRows["messages"],
              parts: conn.prepare("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY id").all(s.id) as OpencodeRows["parts"],
            });
          } finally {
            conn.close();
          }
        },
      }));
  } finally {
    db.close();
  }
}

export async function listForeignSessions(source: ImportSource, cwd: string): Promise<ForeignSession[]> {
  const list =
    source === "claude" ? listClaudeSessions(cwd) : source === "codex" ? listCodexSessions(cwd) : await listOpencodeSessions(cwd);
  return list.sort((a, b) => b.updatedAt - a.updatedAt);
}
