/**
 * Project-memory note frontmatter: read the fields recall needs, and stamp the
 * two the harness owns.
 *
 * A note is `---\nname: …\ndescription: …\nmetadata:\n  type: …\n---\nbody`. Only
 * that small subset of YAML is ever written to a note, so this reads it line by
 * line rather than taking a YAML dependency — and, for the stamp, rewrites only the
 * lines it owns, so the rest of the note keeps its exact bytes (the approval diff
 * then shows the stamp and nothing else).
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

export type NoteFrontmatter = {
  name?: string;
  description?: string;
  /** `metadata.type`, or a top-level `type:` from older notes. */
  type?: string;
  /** `metadata.modified` (ISO), stamped on every write the agent makes. */
  modified?: string;
};

function unquote(v: string): string {
  const t = v.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/** The recall fields of a note, or {} when it has no frontmatter. */
export function readNoteFrontmatter(text: string): NoteFrontmatter {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return {};
  const out: NoteFrontmatter = {};
  let inMetadata = false;
  for (const line of m[1]!.split(/\r?\n/)) {
    const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (top) {
      const [, key, value] = top;
      inMetadata = key === "metadata" && !value!.trim();
      if (key === "name") out.name = unquote(value!);
      else if (key === "description") out.description = unquote(value!);
      else if (key === "type" && !out.type) out.type = unquote(value!);
      continue;
    }
    const child = inMetadata && line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/);
    if (child) {
      const [, key, value] = child;
      if (key === "type") out.type = unquote(value!);
      else if (key === "modified") out.modified = unquote(value!);
    }
  }
  return out;
}

/**
 * Set `metadata.modified` (and `metadata.originSessionId` when known) on a note.
 *
 * Returns the text unchanged when it has no frontmatter: a file without one is not
 * a note in the store's format, and inventing a header for it would be a bigger
 * edit than the agent made. Existing values are replaced in place; a missing
 * `metadata:` block is added at the end of the frontmatter.
 */
export function stampNoteFrontmatter(
  text: string,
  stamp: { modified: string; originSessionId?: string },
): string {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = m[1]!.split(/\r?\n/);
  const wanted: Array<[string, string]> = [["modified", stamp.modified]];
  if (stamp.originSessionId) {
    wanted.push(["originSessionId", stamp.originSessionId]);
  }

  const metaAt = lines.findIndex((l) => /^metadata:\s*$/.test(l));
  if (metaAt < 0) {
    lines.push("metadata:", ...wanted.map(([k, v]) => `  ${k}: ${v}`));
  } else {
    let end = metaAt + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end]!)) end++;
    const indent = lines[metaAt + 1]?.match(/^(\s+)\S/)?.[1] ?? "  ";
    for (const [key, value] of wanted) {
      const at = lines.findIndex(
        (l, i) =>
          i > metaAt && i < end && new RegExp(`^\\s+${key}:`).test(l),
      );
      if (at >= 0) {
        lines[at] = `${indent}${key}: ${value}`;
      } else {
        lines.splice(end, 0, `${indent}${key}: ${value}`);
        end++;
      }
    }
  }
  const header = `---${eol}${lines.join(eol)}${eol}---${m[2] ? m[2] : ""}`;
  return header + text.slice(m[0].length);
}
