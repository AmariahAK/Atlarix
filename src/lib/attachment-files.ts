/**
 * Where an attachment's bytes are written as a file (for the model to read, and
 * for view_image): a PRIVATE per-user folder under the Atlarix home, not the
 * shared temp folder.
 *
 * WHY. `os.tmpdir()/atlarix-attachments` is a fixed name in `/tmp` on Linux,
 * shared by every local user: another user could read a chat's images (files
 * were 0644) or create the folder first and plant a link where the next write
 * would land. Here the folder is 0700 and must be a real directory of ours,
 * files are 0600 and created exclusively (`wx`), so a write never follows a
 * link. On Windows the Atlarix home is inside the user's profile, which is
 * already theirs alone.
 *
 * Files are short-lived copies of bytes the chat keeps: a turn deletes its own
 * after 30 minutes, the rest are pruned after a day, and an image whose file is
 * gone is written again from its record (`ensureImageFile`).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { atlarixHomeDir } from "@/paths/atlarix-home";

const POSIX = process.platform !== "win32";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function ownedByMe(st: fs.Stats): boolean {
  return !POSIX || typeof process.getuid !== "function" || st.uid === process.getuid();
}

/** The folder, created 0700 if needed, and refused if it is a link or not ours. */
export function attachmentsDir(): string {
  const dir = path.join(atlarixHomeDir(), "attachments");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || !ownedByMe(st)) {
    throw new Error(`${dir} is not a private folder of this user`);
  }
  if (POSIX && (st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  return dir;
}

/** `<id><ext>`: the id made safe for a file name, the original extension kept. */
export function attachmentFileName(id: string, filename: string): string {
  let base = id.replace(/[^\w.-]/g, "_");
  if (base === "" || base === "." || base === "..") base = `_${base}`;
  const ext = path.extname(path.basename(filename)).replace(/[^\w.]/g, "");
  return `${base}${ext}`;
}

/** Write a file there, 0600, never through a link; the same name again replaces it. */
export async function writeAttachmentFile(name: string, bytes: Buffer): Promise<string> {
  const file = path.join(attachmentsDir(), path.basename(name));
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
      return file;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw e;
      // The same attachment again (or whatever sits under its name): unlink
      // removes a link itself, never its target, then the write is exclusive.
      await fsp.rm(file, { force: true });
    }
  }
}

function writeAttachmentFileSync(name: string, bytes: Buffer): string {
  const file = path.join(attachmentsDir(), path.basename(name));
  try {
    fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    fs.rmSync(file, { force: true });
    fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  }
  return file;
}

/** A recorded path is used only while it is a plain file of ours (never a link). */
function usableRecordedPath(p: string | undefined): boolean {
  if (!p) return false;
  try {
    const st = fs.lstatSync(p);
    return st.isFile() && !st.isSymbolicLink() && ownedByMe(st);
  } catch {
    return false;
  }
}

/**
 * A file view_image can open for an image attachment: the one written when it
 * was attached (an older Atlarix's temp path included) while it is still ours,
 * else its bytes written again into the private folder.
 */
export function ensureImageFile(a: { id: string; filename: string; data: string; path?: string }): { path?: string } {
  try {
    if (usableRecordedPath(a.path)) return { path: a.path };
    return { path: writeAttachmentFileSync(attachmentFileName(a.id, a.filename), Buffer.from(a.data, "base64")) };
  } catch {
    return {};
  }
}

/** Files older than a day: copies of bytes the chat still has. Never a failure. */
export function pruneAttachmentFiles(now = Date.now()): void {
  try {
    const dir = attachmentsDir();
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        const st = fs.lstatSync(file);
        if (now - st.mtimeMs > MAX_AGE_MS) fs.rmSync(file, { force: true });
      } catch {
        /* gone already */
      }
    }
  } catch {
    /* no folder yet, or unreadable: nothing to prune */
  }
}
