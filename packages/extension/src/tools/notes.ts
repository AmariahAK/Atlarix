/**
 * `remember`, `read_note`, `forget_note`.
 *
 * `remember` KEEPS ITS NAME, and that is the highest-value decision in this
 * file. Models have a strong prior toward it — from this extension's previous
 * schema and from the wider ecosystem — so renaming it to `write_note` would
 * guarantee a period where the model calls a tool that no longer exists, on its
 * first interesting turn, and burns a round learning otherwise. It also still
 * accepts the legacy `{fact}` shape for the same reason: a model that sends the
 * old arguments must get a sensible outcome and a sentence teaching the new
 * shape, not a schema error.
 *
 * THERE IS NO `list_notes`. The index rides every round already; a list tool
 * would make the user pay for the same information twice — once inside the
 * cached prefix and once as a tool result — and would invite the model to call
 * it before every write.
 *
 * NOR IS THIS ONE MULTIPLEXED TOOL with an `action` enum. It saves ~160 tokens,
 * destroys the `remember` prior entirely, and makes a wrong enum value delete a
 * note. `recall`'s own docblock records what multiplexing cost there.
 */

import { checkWrite, planNotesCompaction } from "../memory/compaction";
import { copiedRefusal, looksCopiedFromPage } from "../memory/egress";
import {
  describeSize,
  parseNoteRef,
  renderNoteFile,
} from "../memory/index-render";
import { byteLength } from "../memory/limits";
import {
  deleteNote,
  isValidName,
  listNotes,
  readNote,
  saveNote,
  slugify,
  type NoteType,
} from "../memory/notes";
import { MIGRATED_NOTE } from "../memory/migrate";
import type { ToolOutcome } from "./dispatch";

const TYPES: readonly string[] = ["project", "feedback", "reference", "user"];

function asType(v: unknown): NoteType {
  return typeof v === "string" && TYPES.includes(v) ? (v as NoteType) : "user";
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * What `remember` was asked to write, from whatever shape arrived.
 *
 * Three shapes are accepted and only the first is advertised:
 *   1. `{note, title, description, body}` — the real one.
 *   2. `{fact}` — LEGACY. Appends a bullet to `about-me`.
 *   3. `{title, body}` with no `note` — the name is slugified from the title.
 */
export async function remember(
  args: Record<string, unknown>,
  recentToolResults: readonly string[],
): Promise<ToolOutcome> {
  const legacyFact = str(args.fact).trim();
  const rawName = str(args.note).trim();
  const title = str(args.title).trim();
  const bodyIn = str(args.body);
  const appendIn = str(args.append);

  // ── Legacy `{fact}`: append a bullet to about-me. ────────────────────────
  if (legacyFact && !rawName && !bodyIn && !appendIn) {
    const existing = await readNote(MIGRATED_NOTE);
    const body = existing
      ? `${existing.body.replace(/\s+$/, "")}\n- ${legacyFact}`
      : `- ${legacyFact}`;
    return await write(
      {
        name: MIGRATED_NOTE,
        title: existing?.title || "About me",
        description:
          existing?.description || "things the user has told Atlarix about themselves",
        type: existing?.type ?? "user",
        body,
      },
      recentToolResults,
      "Added to about-me.md. Notes are files now — pass note, title, " +
        "description and body to write a whole one.",
    );
  }

  const name = isValidName(rawName)
    ? rawName
    : rawName
      ? slugify(rawName)
      : slugify(title);

  if (!name) {
    return {
      content:
        "Not saved — a note needs a `note` name (lowercase, hyphens) or a " +
        "`title` to derive one from.",
      label: "Saved nothing",
    };
  }

  const existing = await readNote(name);

  // ── `append`: cheaper than re-sending a whole note. ──────────────────────
  // WITHOUT THIS, adding one line to a 24 KB note costs ~6,000 output tokens,
  // so the model will not do it — it will write a second near-duplicate note
  // instead, which is exactly the drift the desktop's guide warns about.
  if (appendIn && !bodyIn) {
    if (!existing) {
      return {
        content:
          `Not saved — there is no note called ${name}.md to append to. ` +
          `Write it with \`body\` first.`,
        label: "Saved nothing",
      };
    }
    return await write(
      {
        name,
        title: title || existing.title,
        description: str(args.description).trim() || existing.description,
        type: args.type ? asType(args.type) : existing.type,
        body: `${existing.body.replace(/\s+$/, "")}\n${appendIn}`,
      },
      recentToolResults,
    );
  }

  if (!bodyIn) {
    return {
      content: existing
        ? `Not saved — ${name}.md already exists and you sent no \`body\`. ` +
          `Read it with read_note first, then write the whole note back, or ` +
          `use \`append\` to add to it.`
        : `Not saved — a new note needs a \`body\`.`,
      label: "Saved nothing",
    };
  }

  return await write(
    {
      name,
      title: title || existing?.title || name,
      description: str(args.description).trim() || existing?.description || "",
      type: args.type ? asType(args.type) : (existing?.type ?? "user"),
      body: bodyIn,
    },
    recentToolResults,
  );
}

async function write(
  input: {
    name: string;
    title: string;
    description: string;
    type: NoteType;
    body: string;
  },
  recentToolResults: readonly string[],
  prefix?: string,
): Promise<ToolOutcome> {
  // EGRESS BEFORE SIZE. A copied page is refused for what it IS, and telling
  // someone to shorten it first would be advice toward a note that still must
  // not be written.
  const copied = looksCopiedFromPage(input.body, recentToolResults);
  if (copied.copied) {
    return { content: copiedRefusal(copied.overlap), label: "Saved nothing" };
  }

  const notes = await listNotes();
  const bytes = byteLength(input.body);
  const verdict = checkWrite({ notes }, { name: input.name, bytes });
  if (!verdict.ok) {
    return { content: verdict.reason, label: "Saved nothing" };
  }

  const saved = await saveNote(input);
  const existed = notes.some((n) => n.name === input.name);
  const parts = [
    prefix ?? `${existed ? "Updated" : "Saved"} ${saved.name}.md.`,
  ];
  if (verdict.nudge) parts.push(verdict.nudge);
  return {
    content: parts.join(" "),
    label: `${existed ? "Updated" : "Saved"} ${saved.title || saved.name}`,
  };
}

export async function readNoteTool(
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const name = parseNoteRef(str(args.note));
  if (!name) {
    return { content: "Which note? Pass `note`.", label: "Read nothing" };
  }
  const note = await readNote(name);
  if (!note) {
    const notes = await listNotes();
    return {
      content:
        `There is no note called ${name}.md. ` +
        (notes.length
          ? `You have: ${notes.map((n) => `${n.name}.md`).join(", ")}.`
          : `You have no notes yet.`),
      label: "Read nothing",
    };
  }
  return {
    // THE FRAMING LIVES HERE, not in the index. "They said this themselves"
    // is true of a `user` note and a lie about a `reference` or `project` one,
    // so it is said per-note, where the type is known.
    content:
      (note.type === "user"
        ? "The user told you this themselves; treat it as true and current.\n\n"
        : "") + renderNoteFile(note),
    label: `Read ${note.title || note.name}`,
  };
}

export async function forgetNote(
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const name = parseNoteRef(str(args.note));
  if (!name) {
    return { content: "Which note? Pass `note`.", label: "Deleted nothing" };
  }
  const gone = await deleteNote(name);
  return gone
    ? { content: `Deleted ${name}.md.`, label: `Deleted ${name}` }
    : {
        content: `There is no note called ${name}.md, so nothing was deleted.`,
        label: "Deleted nothing",
      };
}

/** Re-exported so the panel can show the same figures the model is told. */
export { planNotesCompaction, describeSize };
