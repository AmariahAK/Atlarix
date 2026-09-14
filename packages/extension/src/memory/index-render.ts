/**
 * Turning notes into the lines the model sees, and one note into a file.
 *
 * SEPARATE FROM `notes.ts` SO THE PROMPT BUILDER NEEDS NO STORAGE. `prompt.ts`
 * takes a pre-rendered string, which means its tests construct a context
 * literal rather than driving a fake `chrome.storage` to produce one — and it
 * means this rendering has tests of its own rather than being asserted through
 * a prompt snapshot.
 */

import { planNotesCompaction } from "./compaction";
import { MAX_NOTES, NOTE_MAX_BYTES } from "./limits";
import type { Note, NoteMeta } from "./notes";

export interface NotesSection {
  index: string;
  count: number;
  limit: number;
  flag?: string;
}

/** `- [Metric units](preferences.md) — wants metric in every answer` */
export function indexLine(meta: NoteMeta): string {
  const title = meta.title.trim() || meta.name;
  const hook = meta.description.trim();
  return `- [${title}](${meta.name}.md)${hook ? ` — ${hook}` : ""}`;
}

/**
 * The whole section, or null when there is nothing to say.
 *
 * NULL AT ZERO NOTES, and the section is then omitted entirely rather than
 * rendered empty. The desktop's rule and its stated reason: "a 'you have 0
 * notes' line is pure cost" — it is paid on every round of every turn by every
 * user who has never saved anything, which is most of them.
 */
export function buildNotesSection(notes: NoteMeta[]): NotesSection | null {
  if (notes.length === 0) return null;
  const plan = planNotesCompaction({ notes });
  return {
    index: notes.map(indexLine).join("\n"),
    count: notes.length,
    limit: MAX_NOTES,
    flag: plan?.flag,
  };
}

/**
 * One note, rendered as the file the model was trained to expect.
 *
 * FRONTMATTER IS A RENDER, NOT A STORAGE FORMAT. This package ships zero
 * dependencies and has no YAML parser, and asking a model to emit parseable
 * YAML is a failure mode with no upside — so `remember` takes title,
 * description and type as typed parameters and they are re-assembled here. The
 * shape matches `src/skills/guides/memory.md` exactly, so the desktop's written
 * convention transfers without a second document.
 */
export function renderNoteFile(note: Note): string {
  return [
    "---",
    `name: ${note.name}`,
    `description: ${note.description}`,
    "metadata:",
    `  type: ${note.type}`,
    "---",
    "",
    note.body,
  ].join("\n");
}

/**
 * Accept the string the model will actually send.
 *
 * It pastes back whatever it saw in the index — `preferences`,
 * `preferences.md`, or the entire line `- [Title](preferences.md) — hook`.
 * Refusing any of those costs a whole round trip to teach a lesson worth
 * nothing, which is the same argument `ask_user_options.ts` makes at length
 * about option shapes.
 */
export function parseNoteRef(raw: string): string {
  const s = raw.trim();
  const link = /\(([^)]+?)(?:\.md)?\)/.exec(s);
  const base = link?.[1] ?? s;
  return base
    .trim()
    .replace(/^[-*]\s*/, "")
    .replace(/\.md$/i, "")
    .trim();
}

/** How much of the per-note budget is gone, for a result line. */
export function describeSize(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB of ${(NOTE_MAX_BYTES / 1024).toFixed(0)} KB`;
}
