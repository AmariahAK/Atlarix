/**
 * Project memory in the conversation: what a user message carries with it.
 *
 * The RULES for memory live in the cache-stable system header and never change.
 * Everything that does change rides the user row instead, as `<system-reminder>`
 * blocks folded into its `modelContent` before the row is saved:
 *
 *  - the MEMORY.md index, on the first message of a session and on the first one
 *    after a compaction (the summary replaced the row that carried it);
 *  - a notice when MEMORY.md changed on disk since the session last saw it;
 *  - up to five notes recalled for this message (`recall.ts`), each at most once
 *    per session unless it changed.
 *
 * Saved with the row, the reminders replay byte for byte on every later request,
 * so they cache like any other history — where the old per-turn index section in
 * the system block re-priced the whole prefix every time a note was written. And
 * because "already shown" is read back from those same rows, it survives restarts.
 */

import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";
import type { LargeLanguageModel } from "@/lib/schemas";
import {
  MEMORY_INDEX_FILE,
  adoptMisplacedMemoryDir,
  isAgentMemoryDisabled,
  listMemoryNoteSizes,
  memoryDirFor,
  memoryIndexPathFor,
  migrateLegacyMemoryMd,
  planMemoryCompaction,
} from "@/lib/agent-memory";
import { sliceFromLastCompactionSummary } from "@/lib/context/compaction";
import {
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
  systemReminder,
} from "@/lib/streaming/system-reminder";
import { readNoteFrontmatter } from "./note-frontmatter";
import { getKnownMemoryIndex, setKnownMemoryIndex } from "./index-state";
import {
  ageLabel,
  selectRelevantMemories,
  type RecallCandidate,
} from "./recall";

const logger = log.scope("memory-context");

/** The index as shown: past either limit it is cut and consolidation is asked for. */
export const MEMORY_INDEX_MAX_LINES = 200;
export const MEMORY_INDEX_MAX_BYTES = 25 * 1024;
/** A recalled note is attached up to this size; the rest is a read_file away. */
export const RECALL_NOTE_MAX_BYTES = 4 * 1024;
/** A change notice past this many lines re-attaches the index instead. */
const CHANGE_NOTICE_MAX_LINES = 40;
/** Notes the selector is shown, newest first — its prompt must stay small. */
const RECALL_CANDIDATE_LIMIT = 200;

const INDEX_HEAD_TAIL = "(project memory, persists across sessions):";
const CHANGE_HEAD = "MEMORY.md changed on disk since you last read it";
const RECALL_HEAD = "Recalled project memory";

type HistoryRow = {
  role: string;
  content?: string | null;
  modelContent?: string | null;
  kind?: string | null;
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── The index ────────────────────────────────────────────────────────────────

/** The index as it is shown, and whether the cap cut it. */
export function capMemoryIndex(raw: string): { text: string; cut: boolean } {
  const trimmed = raw.trim();
  let lines = trimmed ? trimmed.split(/\r?\n/) : [];
  let cut = false;
  if (lines.length > MEMORY_INDEX_MAX_LINES) {
    lines = lines.slice(0, MEMORY_INDEX_MAX_LINES);
    cut = true;
  }
  let text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") > MEMORY_INDEX_MAX_BYTES) {
    // Cut on a line boundary so no pointer is left half-written.
    while (lines.length && Buffer.byteLength(lines.join("\n"), "utf8") > MEMORY_INDEX_MAX_BYTES) {
      lines.pop();
    }
    text = lines.join("\n");
    cut = true;
  }
  return { text, cut };
}

/** Comparable form of an index: its non-blank lines, after the cap. */
function indexLines(raw: string): string[] {
  return capMemoryIndex(raw)
    .text.split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
}

export function renderIndexReminder(indexPath: string, raw: string): string {
  const { text, cut } = capMemoryIndex(raw);
  const block = systemReminder(
    `Contents of ${indexPath} ${INDEX_HEAD_TAIL}\n\n${text || "(empty)"}`,
  );
  if (!cut) return block;
  return `${block}\n\n${systemReminder(
    `MEMORY.md is past its ${MEMORY_INDEX_MAX_LINES}-line / ${MEMORY_INDEX_MAX_BYTES / 1024} KB limit, so only the part above was shown. Consolidate it: merge notes that overlap, delete stale ones, and keep each index line to one short pointer.`,
  )}`;
}

/** Multiset difference, a − b. */
function minus(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const l of b) left.set(l, (left.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of a) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else out.push(l);
  }
  return out;
}

/**
 * What the visible history last showed of this index: the last full copy, with
 * every later change notice applied. Undefined when no copy is in view.
 */
export function deriveShownIndexLines(
  rows: HistoryRow[],
  indexPath: string,
): string[] | undefined {
  const indexRe = new RegExp(
    `${escapeRe(SYSTEM_REMINDER_OPEN)}\\nContents of ${escapeRe(indexPath)} ${escapeRe(INDEX_HEAD_TAIL)}\\n\\n([\\s\\S]*?)\\n${escapeRe(SYSTEM_REMINDER_CLOSE)}`,
  );
  const changeRe = new RegExp(
    `${escapeRe(SYSTEM_REMINDER_OPEN)}\\n${escapeRe(CHANGE_HEAD)}[^\\n]*\\(${escapeRe(indexPath)}\\)\\n([\\s\\S]*?)\\n${escapeRe(SYSTEM_REMINDER_CLOSE)}`,
  );
  let shown: string[] | undefined;
  for (const row of rows) {
    if (row.role !== "user" || !row.modelContent) continue;
    const full = row.modelContent.match(indexRe);
    if (full) {
      shown = full[1] === "(empty)" ? [] : indexLines(full[1]!);
      continue;
    }
    const change = shown && row.modelContent.match(changeRe);
    if (change) {
      const added: string[] = [];
      const removed: string[] = [];
      for (const l of change[1]!.split("\n")) {
        if (l.startsWith("+ ")) added.push(l.slice(2));
        else if (l.startsWith("- ")) removed.push(l.slice(2));
      }
      shown = [...minus(shown!, removed), ...added];
    }
  }
  return shown;
}

/**
 * The notice for an index that changed under the session, or null when it did
 * not. Past `CHANGE_NOTICE_MAX_LINES` the caller re-attaches the whole index.
 */
export function renderIndexChangeNotice(
  indexPath: string,
  before: string[],
  after: string[],
): string | null | "too-large" {
  const added = minus(after, before);
  const removed = minus(before, after);
  if (!added.length && !removed.length) return null;
  if (added.length + removed.length > CHANGE_NOTICE_MAX_LINES) return "too-large";
  return systemReminder(
    [
      `${CHANGE_HEAD}; take it as the current state (${indexPath})`,
      ...added.map((l) => `+ ${l}`),
      ...removed.map((l) => `- ${l}`),
    ].join("\n"),
  );
}

// ── Recall ───────────────────────────────────────────────────────────────────

/** Note file → the exact body the visible history already showed for it. */
export function deriveRecalledNotes(rows: HistoryRow[]): Map<string, string> {
  const re = new RegExp(
    `${escapeRe(SYSTEM_REMINDER_OPEN)}\\n${escapeRe(RECALL_HEAD)} \`([^\`]+)\` \\([^\\n]*\\):\\n\\n([\\s\\S]*?)\\n${escapeRe(SYSTEM_REMINDER_CLOSE)}`,
    "g",
  );
  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.role !== "user" || !row.modelContent) continue;
    for (const m of row.modelContent.matchAll(re)) {
      out.set(path.basename(m[1]!), m[2]!);
    }
  }
  return out;
}

/** The body a note is attached with: whole, or cut at the size limit. */
export function recalledNoteBody(text: string): string {
  const body = text.trim();
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length <= RECALL_NOTE_MAX_BYTES) return body;
  // Cut on a character boundary, then say where the rest is.
  const head = bytes.subarray(0, RECALL_NOTE_MAX_BYTES).toString("utf8").replace(/�+$/, "");
  return `${head}\n… (cut at ${RECALL_NOTE_MAX_BYTES / 1024} KB; read_file the note for the rest)`;
}

export function renderRecalledNote(
  absPath: string,
  ageDays: number,
  text: string,
): string {
  return `${SYSTEM_REMINDER_OPEN}\n${RECALL_HEAD} \`${absPath}\` (background, written ${ageLabel(ageDays)}; verify before relying on it):\n\n${recalledNoteBody(text)}\n${SYSTEM_REMINDER_CLOSE}`;
}

type NoteOnDisk = { file: string; abs: string; text: string; ageDays: number; description: string; type?: string; mtimeMs: number };

async function readNotes(dir: string, now: number): Promise<NoteOnDisk[]> {
  let names: string[];
  try {
    names = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== MEMORY_INDEX_FILE)
      .map((e) => e.name);
  } catch {
    return [];
  }
  const notes = await Promise.all(
    names.map(async (file): Promise<NoteOnDisk | null> => {
      const abs = path.join(dir, file);
      try {
        const [text, st] = await Promise.all([fs.readFile(abs, "utf8"), fs.stat(abs)]);
        const fm = readNoteFrontmatter(text);
        const stamped = fm.modified ? Date.parse(fm.modified) : NaN;
        const written = Number.isFinite(stamped) ? stamped : st.mtimeMs;
        return {
          file,
          abs,
          text,
          ageDays: Math.max(0, Math.floor((now - written) / 86_400_000)),
          description: fm.description ?? "",
          ...(fm.type ? { type: fm.type } : {}),
          mtimeMs: st.mtimeMs,
        };
      } catch {
        return null; // vanished mid-scan
      }
    }),
  );
  return notes.filter((n): n is NoteOnDisk => n != null);
}

// ── The whole thing, per user message ───────────────────────────────────────

export type MemoryTurnContextArgs = {
  workspacePath: string;
  /** Read scope of the session (`resolveReadScope`), for the index baseline. */
  scope: string | null;
  /** The conversation BEFORE this message, as the transport holds it. */
  history: HistoryRow[];
  userText: string;
  chatId?: number | null;
  turnModel?: LargeLanguageModel;
  /** Test seam for the side model call. */
  select?: typeof selectRelevantMemories;
  now?: number;
};

/**
 * The reminders to fold into this user message's model content, or "" when there
 * is nothing to add. Never throws: memory is optional and never blocks a turn.
 */
export async function buildMemoryTurnContext(
  args: MemoryTurnContextArgs,
): Promise<string> {
  const { workspacePath } = args;
  if (!workspacePath || isAgentMemoryDisabled()) return "";
  try {
    // Carry a pre-v14.23.0 `.atlarix/memory.md` and any guessed-path notes into
    // the store first. Both are idempotent.
    const { readMemoryMd } = await import("@/lib/project-memory");
    const legacy = await readMemoryMd(workspacePath);
    if (legacy) await migrateLegacyMemoryMd(workspacePath, legacy);
    await adoptMisplacedMemoryDir(workspacePath);

    const dir = memoryDirFor(workspacePath);
    const indexPath = memoryIndexPathFor(workspacePath);
    const now = args.now ?? Date.now();
    const notes = await readNotes(dir, now);
    if (notes.length === 0) return "";

    const visible = sliceFromLastCompactionSummary(
      args.history.map((m) => ({
        ...m,
        content: m.role === "user" ? (m.modelContent ?? m.content ?? "") : (m.content ?? ""),
      })),
    );

    const parts: string[] = [];
    let raw = "";
    try {
      raw = await fs.readFile(indexPath, "utf8");
    } catch {
      raw = "";
    }
    const current = indexLines(raw);
    const shownInView = deriveShownIndexLines(visible, indexPath);
    let attachIndex = shownInView === undefined;
    if (!attachIndex) {
      const ownWrite = getKnownMemoryIndex(args.scope, indexPath);
      const before = ownWrite !== undefined ? indexLines(ownWrite) : shownInView!;
      const notice = renderIndexChangeNotice(indexPath, before, current);
      if (notice === "too-large") attachIndex = true;
      else if (notice) parts.push(notice);
    }
    if (attachIndex) parts.push(renderIndexReminder(indexPath, raw));
    setKnownMemoryIndex(args.scope, indexPath, raw);
    if (attachIndex || parts.length) {
      // The compaction flag rides whatever index text this message carries.
      const plan = planMemoryCompaction({ notes: await listMemoryNoteSizes(workspacePath) });
      if (plan) parts.push(systemReminder(`Project memory ${plan.flag}.`));
    }

    const recalled = deriveRecalledNotes(visible);
    const fresh = notes
      .filter((n) => recalled.get(n.file) !== recalledNoteBody(n.text))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, RECALL_CANDIDATE_LIMIT);
    if (fresh.length && args.userText.trim()) {
      const candidates: RecallCandidate[] = fresh.map((n) => ({
        file: n.file,
        description: n.description,
        ...(n.type ? { type: n.type } : {}),
        ageDays: n.ageDays,
      }));
      // A failed recall costs this message its recalled notes, never its index.
      const chosen = await (args.select ?? selectRelevantMemories)({
        message: args.userText,
        candidates,
        chatId: args.chatId,
        turnModel: args.turnModel,
        memoryDir: dir,
      }).catch(() => [] as string[]);
      const byFile = new Map(fresh.map((n) => [n.file, n]));
      for (const file of chosen) {
        const n = byFile.get(file);
        if (n) parts.push(renderRecalledNote(n.abs, n.ageDays, n.text));
      }
      if (chosen.length) logger.info(`[memory] recalled ${chosen.join(", ")}`);
    }
    return parts.join("\n\n");
  } catch (err) {
    logger.warn("[memory] turn context skipped:", err);
    return "";
  }
}

/** The user row's model content with the reminders in front of the message. */
export function withMemoryContext(userModelText: string, reminders: string): string {
  return reminders ? `${reminders}\n\n${userModelText}` : userModelText;
}
