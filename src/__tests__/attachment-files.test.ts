/**
 * Attachment files live in a PRIVATE per-user folder under the Atlarix home
 * (0700, files 0600, created exclusively), not in the shared temp folder: on a
 * multi-user Linux machine `/tmp/atlarix-attachments` let another local user
 * read a chat's images, or plant a link where the next write would land.
 * Paths an older Atlarix recorded still resolve when the file there is a plain
 * file of ours; anything else is written again from the record's bytes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachmentFileName,
  attachmentsDir,
  ensureImageFile,
  pruneAttachmentFiles,
  writeAttachmentFile,
} from "@/lib/attachment-files";

const posix = process.platform !== "win32";
let home: string;
const prevHome = process.env.ATLARIX_HOME_DIR;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-attach-test-"));
  process.env.ATLARIX_HOME_DIR = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.ATLARIX_HOME_DIR;
  else process.env.ATLARIX_HOME_DIR = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe("attachment files", () => {
  it("the folder is under the Atlarix home, private to this user", () => {
    const dir = attachmentsDir();
    expect(dir).toBe(path.join(home, "attachments"));
    if (posix) expect(mode(dir)).toBe(0o700);
  });

  it("a folder that already existed open to others is closed again", () => {
    fs.mkdirSync(path.join(home, "attachments"), { mode: 0o777 });
    fs.chmodSync(path.join(home, "attachments"), 0o777);
    const dir = attachmentsDir();
    if (posix) expect(mode(dir)).toBe(0o700);
  });

  it("a link in the folder's place is refused, never followed", () => {
    if (!posix) return;
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-attach-elsewhere-"));
    fs.symlinkSync(elsewhere, path.join(home, "attachments"));
    expect(() => attachmentsDir()).toThrow(/not a private folder/);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it("writes 0600, created exclusively; the same name again replaces it", async () => {
    const p = await writeAttachmentFile("abc.png", Buffer.from("one"));
    expect(path.dirname(p)).toBe(attachmentsDir());
    if (posix) expect(mode(p)).toBe(0o600);
    const again = await writeAttachmentFile("abc.png", Buffer.from("two"));
    expect(again).toBe(p);
    expect(fs.readFileSync(p, "utf8")).toBe("two");
  });

  it("a link planted under the file's name is replaced, not written through", async () => {
    if (!posix) return;
    const target = path.join(home, "victim.txt");
    fs.writeFileSync(target, "keep me");
    fs.symlinkSync(target, path.join(attachmentsDir(), "abc.png"));
    const p = await writeAttachmentFile("abc.png", Buffer.from("image"));
    expect(fs.readFileSync(target, "utf8")).toBe("keep me");
    expect(fs.lstatSync(p).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(p, "utf8")).toBe("image");
  });

  it("names: the id made safe, the original extension kept, no path in it", () => {
    expect(attachmentFileName("a/b\\..:c", "shot.PNG")).toBe("a_b_.._c.PNG");
    expect(attachmentFileName("id1", "../../evil")).toBe("id1");
    expect(path.basename(attachmentFileName("..", "x.png"))).not.toBe("..");
  });

  it("an image: a recorded path that is still our plain file is used as is", () => {
    const old = path.join(home, "legacy.png");
    fs.writeFileSync(old, "bytes");
    expect(ensureImageFile({ id: "i1", filename: "x.png", data: "Ynl0ZXM=", path: old })).toEqual({ path: old });
  });

  it("an image: a recorded path that is gone, or a link, is written again from the record", () => {
    const data = Buffer.from("png-bytes").toString("base64");
    const gone = ensureImageFile({ id: "i2", filename: "x.png", data, path: path.join(home, "missing.png") });
    expect(path.dirname(gone.path!)).toBe(attachmentsDir());
    expect(fs.readFileSync(gone.path!, "utf8")).toBe("png-bytes");
    if (posix) {
      const link = path.join(home, "link.png");
      fs.symlinkSync(path.join(home, "anything"), link);
      const relinked = ensureImageFile({ id: "i3", filename: "x.png", data, path: link });
      expect(relinked.path).not.toBe(link);
      expect(path.dirname(relinked.path!)).toBe(attachmentsDir());
    }
  });

  it("prunes files older than a day, keeps newer ones", async () => {
    const fresh = await writeAttachmentFile("new.png", Buffer.from("n"));
    const stale = await writeAttachmentFile("old.png", Buffer.from("o"));
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
    pruneAttachmentFiles();
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
  });
});
