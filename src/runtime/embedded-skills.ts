/**
 * The bundled skills (src/skills) as a real folder, for the CLI and headless
 * builds. The skill loader, the guide index and `read_file` of a guide all
 * join paths under one root, and a compiled binary's embedded files have no
 * folder structure — so they are written out once to
 * `<atlarix home>/skills/<sha12>/` (`~/.atlarix`, or a scratch profile's own
 * folder: a QA run with ATLARIX_USER_DATA_DIR wrote into the person's), named by
 * content like the helpers in embedded-bin.ts: a new version gets a new folder,
 * never a half-written one.
 *
 * When the files already sit in their folder on disk (plain `bun`, tests, the
 * Node build's shipped `skills/`), that folder is used as it is.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atlarixHomeDir } from "@/paths/atlarix-home";

/** Where written-out copies live: `<atlarix home>/skills`. */
export function skillsCacheRoot(atlarixHome: string = atlarixHomeDir()): string {
  return path.join(atlarixHome, "skills");
}

export function skillsDirFrom(
  files: Record<string, string> | undefined,
  atlarixHome: string = atlarixHomeDir(),
): string | undefined {
  const entries = Object.entries(files ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return undefined;

  const [rel0, src0] = entries[0]!;
  const root = path.resolve(path.dirname(src0), ...rel0.split("/").slice(1).map(() => ".."));
  if (entries.every(([rel, src]) => path.resolve(src) === path.join(root, ...rel.split("/")))) return root;

  const bodies = entries.map(([rel, src]) => [rel, fs.readFileSync(src)] as const);
  const hash = crypto.createHash("sha256");
  for (const [rel, body] of bodies) hash.update(rel).update("\0").update(body).update("\0");
  const dir = path.join(skillsCacheRoot(atlarixHome), hash.digest("hex").slice(0, 12));
  if (fs.existsSync(dir)) return dir;

  const tmp = `${dir}.${process.pid}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [rel, body] of bodies) {
    const dest = path.join(tmp, ...rel.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }
  try {
    fs.renameSync(tmp, dir);
  } catch (e) {
    // Another CLI starting at the same moment wrote the same bytes first.
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(dir)) throw e;
  }
  return dir;
}

/**
 * The build's skills, written out on FIRST USE rather than at startup:
 * `atlarix --version` unpacked them into the profile's folder just to print a
 * version (QA, 2026-10-21). The skill loader asks for them when it needs one.
 */
let pending: { files: Record<string, string> | undefined; atlarixHome?: string } | null = null;

export function registerBundledSkills(files: Record<string, string> | undefined, atlarixHome?: string): void {
  pending = { files, atlarixHome };
}

/** The bundled skills folder, written out now if it has not been; undefined without a build's copy. */
export function bundledSkillsDir(): string | undefined {
  if (process.env.ATLARIX_SKILLS_DIR) return process.env.ATLARIX_SKILLS_DIR;
  if (!pending) return undefined;
  const { files, atlarixHome } = pending;
  pending = null;
  try {
    const dir = skillsDirFrom(files, atlarixHome);
    if (dir) process.env.ATLARIX_SKILLS_DIR = dir;
    return dir;
  } catch {
    // A read-only home: no bundled skills this run; the loader says what is missing.
    return undefined;
  }
}
