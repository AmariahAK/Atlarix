/**
 * The CLI updates itself in the background, then says so (owner's choice,
 * Claude Code's "Update installed" notice): no question, no exit. The next
 * launch runs the new version.
 *
 * WHEN: a release build only, a few seconds after start, at most once a day
 * (Codex: a background check with a cached result, never on the startup path).
 * Off with ATLARIX_DISABLE_AUTOUPDATE=1.
 *
 * HOW depends on how it was installed (Codex `update_action.rs`):
 *   the install script (~/.atlarix/bin)  the same download, checked the same
 *                                        way (public/install), then the new
 *                                        binary is renamed over the old one
 *   Homebrew                             brew upgrade atlarix
 *   npm                                  npm install -g atlarix@<version>
 *   anything else                        only says an update is out
 *
 * Pure decisions are exported for tests; the network and the file system come
 * in through `deps`.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isNewer } from "@/main/update-helpers";

const REPO = "AmariahAK/atlarix-releases";
const DAY_MS = 20 * 60 * 60 * 1000;

export type UpdateEvent =
  | { kind: "installing"; version: string }
  | { kind: "installed"; version: string }
  | { kind: "available"; version: string; how: string }
  | { kind: "failed"; version: string; error: string };

export type InstallMethod = "script" | "brew" | "npm" | "manual";

/** How this binary was installed, from where it lives. */
export function installMethod(binary: string, home = os.homedir(), env = process.env): InstallMethod {
  const p = binary.replace(/\\/g, "/");
  const scriptDirs = [
    env.ATLARIX_INSTALL_DIR,
    path.join(home, ".atlarix", "bin"),
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Atlarix", "bin") : undefined,
  ]
    .filter((d): d is string => !!d)
    .map((d) => d.replace(/\\/g, "/").replace(/\/$/, ""));
  if (scriptDirs.some((d) => p.startsWith(`${d}/`))) return "script";
  if (/\/Cellar\/|\/homebrew\/|\/linuxbrew\//.test(p)) return "brew";
  if (/\/node_modules\/atlarix(-[a-z0-9-]+)?\//.test(p)) return "npm";
  return "manual";
}

/** The release asset for this machine: atlarix-cli-darwin-arm64.tar.gz (as public/install picks it). */
export function assetName(platform = process.platform, arch = process.arch, musl = isMusl()): string {
  const osName = platform === "win32" ? "windows" : platform;
  const archName = arch === "arm64" ? "arm64" : "x64";
  const libc = platform === "linux" && musl ? "-musl" : "";
  return `atlarix-cli-${osName}-${archName}${libc}.${platform === "win32" ? "zip" : "tar.gz"}`;
}

function isMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const report = (process.report?.getReport() ?? {}) as { header?: { glibcVersionRuntime?: string } };
    return !report.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/** The checksum listed for `asset` in a SHA256SUMS file, or null. */
export function checksumFor(sums: string, asset: string): string | null {
  for (const line of sums.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && m[2] === asset) return m[1]!.toLowerCase();
  }
  return null;
}

/** Still due a check (none in the last day)? */
export function due(stampFile: string, now = Date.now()): boolean {
  try {
    const { checkedAt } = JSON.parse(fs.readFileSync(stampFile, "utf8")) as { checkedAt?: number };
    return !checkedAt || now - checkedAt > DAY_MS;
  } catch {
    return true;
  }
}

export interface UpdateDeps {
  fetch: typeof fetch;
  /** The running binary. */
  binary: string;
  /** Where the latest release is described ({ tag_name }). */
  latestUrl: string;
  /** Where a version's files are downloaded from. */
  downloadBase: (version: string) => string;
  stampFile: string;
  run: (cmd: string, args: string[]) => Promise<void>;
}

function defaultDeps(): UpdateDeps {
  const base = process.env.ATLARIX_UPDATE_BASE;
  return {
    fetch,
    binary: fs.realpathSync(process.execPath),
    latestUrl: base ? `${base}/latest` : "https://releases.atlarix.dev/latest",
    downloadBase: (v) => (base ? `${base}/download/v${v}` : `https://github.com/${REPO}/releases/download/v${v}`),
    stampFile: path.join(os.homedir(), ".atlarix", "update-check.json"),
    run: (cmd, args) =>
      new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { stdio: "ignore" });
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
      }),
  };
}

/** Download, check and swap in the new binary, the way public/install does. */
async function replaceBinary(version: string, deps: UpdateDeps): Promise<void> {
  const asset = assetName();
  const base = deps.downloadBase(version);
  const [archive, sums] = await Promise.all([
    deps.fetch(`${base}/${asset}`).then(async (r) => {
      if (!r.ok) throw new Error(`download failed (${r.status})`);
      return Buffer.from(await r.arrayBuffer());
    }),
    deps.fetch(`${base}/SHA256SUMS-cli.txt`).then((r) => {
      if (!r.ok) throw new Error(`checksums missing (${r.status})`);
      return r.text();
    }),
  ]);
  const want = checksumFor(sums, asset);
  if (!want) throw new Error(`no checksum for ${asset}`);
  const got = createHash("sha256").update(archive).digest("hex");
  if (got !== want) throw new Error("checksum mismatch: nothing was changed");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-update-"));
  try {
    const file = path.join(tmp, asset);
    fs.writeFileSync(file, archive);
    // tar reads .zip too on Windows 10+ (bsdtar).
    await deps.run("tar", ["-xf", file, "-C", tmp]);
    const exe = process.platform === "win32" ? "atlarix.exe" : "atlarix";
    const fresh = path.join(tmp, exe);
    if (!fs.existsSync(fresh)) throw new Error("the download had no atlarix binary");
    const next = `${deps.binary}.new`;
    fs.copyFileSync(fresh, next);
    fs.chmodSync(next, 0o755);
    if (process.platform === "win32") {
      // A running .exe can't be overwritten, but it can be renamed; the old one
      // is cleared on the next start (cleanupOldBinary).
      fs.renameSync(deps.binary, `${deps.binary}.old`);
    }
    fs.renameSync(next, deps.binary);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The previous binary a Windows update left behind. */
export function cleanupOldBinary(binary = process.execPath): void {
  try {
    fs.rmSync(`${binary}.old`, { force: true });
  } catch {
    /* still locked: next time */
  }
}

/**
 * Check, and install when there is something newer. Reports through `notify`;
 * never throws. Resolves when done (tests await it; the CLI doesn't).
 */
export async function checkAndUpdate(
  current: string,
  notify: (e: UpdateEvent) => void,
  deps: UpdateDeps = defaultDeps(),
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  if (!force && !due(deps.stampFile)) return;
  let latest: string;
  try {
    const res = await deps.fetch(deps.latestUrl, { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const tag = String(((await res.json()) as { tag_name?: string }).tag_name ?? "");
    latest = tag.replace(/^v/, "");
    fs.mkdirSync(path.dirname(deps.stampFile), { recursive: true });
    fs.writeFileSync(deps.stampFile, JSON.stringify({ checkedAt: Date.now(), latest }));
  } catch {
    return; // offline: try again next start
  }
  if (!latest || !isNewer(latest, current)) return;

  const method = installMethod(deps.binary);
  if (method === "manual") {
    notify({ kind: "available", version: latest, how: "curl -fsSL https://atlarix.dev/install | sh" });
    return;
  }
  notify({ kind: "installing", version: latest });
  try {
    if (method === "script") await replaceBinary(latest, deps);
    else if (method === "brew") await deps.run("brew", ["upgrade", "atlarix"]);
    else await deps.run("npm", ["install", "-g", `atlarix@${latest}`]);
    notify({ kind: "installed", version: latest });
  } catch (e) {
    notify({ kind: "failed", version: latest, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Start the background update for a release build (the TUI calls this). */
export function startAutoUpdate(current: string, notify: (e: UpdateEvent) => void): void {
  if (current === "dev" || process.env.ATLARIX_DISABLE_AUTOUPDATE) return;
  cleanupOldBinary();
  const t = setTimeout(() => void checkAndUpdate(current, notify), 3000);
  t.unref?.();
}
