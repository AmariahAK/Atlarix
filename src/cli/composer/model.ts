/**
 * What the CLI's prompt box holds besides typed text: pasted blocks, images, and
 * references to files and folders. Pure, so the rules are tested without a
 * terminal (src/__tests__/cli-composer-model.test.ts); the TUI keeps the labels
 * atomic in the text box and calls these to build what is sent.
 *
 * The shapes follow the other terminal agents:
 *  - a long paste collapses to `[Pasted text #N +L lines]` (opencode's rule: 3+
 *    lines or 150+ characters) and is expanded back only on submit;
 *  - an image, pasted from the clipboard or as a path, becomes `[Image #N]` and
 *    is SENT to the model, which needs to see it;
 *  - any other file or folder, dropped or pasted as a path, becomes
 *    `[File <path>]` / `[Folder <path>]`: only the path goes to the model, which
 *    reads what it needs with its own tools. Nothing is uploaded.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Attachment =
  | { kind: "paste"; n: number; text: string }
  | { kind: "image"; n: number; path: string; mime: string }
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string };

/** An attachment as it sits in the text box: its label, and what it stands for. */
export interface Placeholder {
  label: string;
  attachment: Attachment;
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function lineCount(text: string): number {
  return (text.match(/\n/g)?.length ?? 0) + 1;
}

/** opencode's threshold for collapsing a paste. */
export function shouldCollapsePaste(text: string): boolean {
  const t = text.trim();
  return lineCount(t) >= 3 || t.length > 150;
}

/** `~` for the home folder, so a label stays short. */
export function displayPath(abs: string, home = os.homedir()): string {
  return abs === home || abs.startsWith(home + path.sep) ? "~" + abs.slice(home.length) : abs;
}

export function labelFor(a: Attachment): string {
  switch (a.kind) {
    case "paste": {
      const lines = lineCount(a.text.trim());
      return `[Pasted text #${a.n} +${lines} ${lines === 1 ? "line" : "lines"}]`;
    }
    case "image":
      return `[Image #${a.n}]`;
    case "file":
      return `[File ${displayPath(a.path)}]`;
    case "folder":
      return `[Folder ${displayPath(a.path)}]`;
  }
}

/**
 * A terminal hands over a dragged or pasted file as its path, in one of a few
 * spellings: quoted, with backslash-escaped spaces (macOS Terminal and iTerm),
 * or as a file:// URL. Returns the plain absolute path, or null when the text
 * is not a single path.
 */
export function pastedPath(text: string, cwd = process.cwd()): string | null {
  let t = text.trim();
  if (!t || t.includes("\n")) return null;
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    t = t.slice(1, -1);
  }
  if (t.startsWith("file://")) {
    try {
      t = decodeURIComponent(new URL(t).pathname);
    } catch {
      return null;
    }
  }
  t = t.replace(/\\(.)/g, "$1");
  if (t.startsWith("~/")) t = path.join(os.homedir(), t.slice(2));
  if (!path.isAbsolute(t) && !t.startsWith("./") && !t.startsWith("../")) return null;
  return path.resolve(cwd, t);
}

export interface FsProbe {
  stat(p: string): { isDirectory(): boolean } | null;
}

const realFs: FsProbe = {
  stat(p) {
    try {
      return fs.statSync(p);
    } catch {
      return null;
    }
  },
};

/** Counters for the next `#N`, per kind, for one draft. */
export interface Counters {
  paste: number;
  image: number;
}

export function freshCounters(): Counters {
  return { paste: 0, image: 0 };
}

/**
 * Decide what a paste becomes. Returns null when it should be inserted as
 * plain text.
 */
export function classifyPaste(
  text: string,
  counters: Counters,
  opts: { cwd?: string; fs?: FsProbe } = {},
): Attachment | null {
  const probe = opts.fs ?? realFs;
  const p = pastedPath(text, opts.cwd);
  if (p) {
    const st = probe.stat(p);
    if (st) {
      if (st.isDirectory()) return { kind: "folder", path: p };
      const mime = IMAGE_MIME[path.extname(p).toLowerCase()];
      if (mime) return { kind: "image", n: ++counters.image, path: p, mime };
      return { kind: "file", path: p };
    }
  }
  if (shouldCollapsePaste(text)) {
    return { kind: "paste", n: ++counters.paste, text: text.replace(/\r\n?/g, "\n") };
  }
  return null;
}

/**
 * The placeholders whose labels still appear in `text`: what re-setting the
 * box's text (history recall, an unsent restore) must keep records for, so a
 * label never sits in the box without its chip (0ab: a paste was sent as its
 * literal "[Pasted text #1 +3 lines]" after a setText wiped the records).
 */
export function placeholdersInText(placeholders: Placeholder[], text: string): Placeholder[] {
  return placeholders.filter((p) => text.includes(p.label));
}

export interface Submission {
  /** What the model receives: pastes expanded, file and folder labels carrying absolute paths. */
  prompt: string;
  /** What the transcript shows: the text as typed, labels intact. */
  display: string;
  /** Images to send as image parts, in label order. */
  images: Array<{ label: string; path: string; mime: string }>;
  /** The chips the display still carries, so a recalled draft can restore them. */
  placeholders: Placeholder[];
}

/**
 * Build what is sent. A placeholder whose label no longer appears in the text
 * was deleted by the user and is dropped (its image is not sent).
 */
export function buildSubmission(text: string, placeholders: Placeholder[]): Submission {
  let prompt = text;
  const images: Submission["images"] = [];
  for (const { label, attachment: a } of placeholders) {
    if (!text.includes(label)) continue;
    switch (a.kind) {
      case "paste":
        prompt = prompt.split(label).join(a.text);
        break;
      case "image":
        images.push({ label, path: a.path, mime: a.mime });
        break;
      case "file":
        prompt = prompt.split(label).join(`[File ${a.path}]`);
        break;
      case "folder":
        prompt = prompt.split(label).join(`[Folder ${a.path}]`);
        break;
    }
  }
  return {
    prompt: prompt.trim(),
    display: text.trim(),
    images,
    placeholders: placeholdersInText(placeholders, text),
  };
}
