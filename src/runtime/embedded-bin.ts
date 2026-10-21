/**
 * Helper executables carried INSIDE the compiled CLI (ripgrep, the sandbox
 * helpers, the Chrome bridge relay), unpacked to disk on first use.
 *
 * A Bun-compiled binary can embed files but cannot exec one from its embedded
 * filesystem, so each is written to `~/.atlarix/bin/<sha12>/<name>`. The folder
 * is named by the CONTENT hash: a new CLI version with a different helper gets
 * a new folder rather than overwriting a file another running CLI may be
 * executing (a running .exe cannot be replaced on Windows). The write goes to a
 * temp file and is renamed into place, so a crash or a concurrent start never
 * leaves a half-written executable.
 *
 * Returns null when there is nothing embedded (Electron, the Node build, tests)
 * so callers keep their existing lookup.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atlarixHomeDir } from "@/paths/atlarix-home";

const unpacked = new Map<string, string>();

/** `<atlarix home>/bin`: a scratch profile's own folder, never the person's ~/.atlarix. */
export function binDir(): string {
  return path.join(atlarixHomeDir(), "bin");
}

/**
 * `source` is the embedded file's path inside the binary (from `atlarix:assets`,
 * published as an env var by src/headless/bundled-assets.ts).
 */
export async function unpackEmbeddedBinary(
  name: string,
  source: string | undefined,
): Promise<string | null> {
  if (!source) return null;
  const hit = unpacked.get(name);
  if (hit) return hit;
  const bytes = new Uint8Array(fs.readFileSync(source));
  const tag = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const dir = path.join(binDir(), tag);
  const dest = path.join(dir, name);

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes, { mode: 0o755 });
    try {
      fs.renameSync(tmp, dest);
    } catch (e) {
      // Another process won the race with identical bytes; theirs is as good.
      fs.rmSync(tmp, { force: true });
      if (!fs.existsSync(dest)) throw e;
    }
  }
  unpacked.set(name, dest);
  return dest;
}
