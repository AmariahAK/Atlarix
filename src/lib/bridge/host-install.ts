/**
 * Installing the native messaging host, which is four files that must all be
 * exactly right and whose failures all look identical.
 *
 * ══ EVERY MISTAKE HERE PRODUCES THE SAME SYMPTOM ══
 *
 * "Specified native messaging host not found", or worse, silence. A missing
 * trailing slash in `allowed_origins`, a wrapper without the executable bit, a
 * manifest in the wrong browser's directory, a host name with a capital letter
 * in it — Chrome reports all of them the same way, and none of them are
 * distinguishable from "the user has not installed the desktop app". That is
 * why each is pinned by a test rather than checked by eye.
 *
 * ══ THE TWO-LEVEL INDIRECTION, WHICH IS THE POINT ══
 *
 * A native messaging manifest hard-codes an absolute `path`. Chrome reads it at
 * spawn time, so the path has to stay valid for as long as the browser profile
 * exists — across app updates, and across a user dragging Atlarix.app to a
 * different folder.
 *
 * So the manifest points at a WRAPPER in the user's home that never changes:
 *
 *     ~/.atlarix/chrome/atlarix-native-host     (mode 0755, byte-stable)
 *     ~/.atlarix/chrome/host.env                (mode 0600, rewritten freely)
 *
 * The wrapper sources `host.env` for the real binary path and the socket, then
 * execs. An update rewrites four lines of `host.env`; the wrapper and every
 * browser's manifest are untouched. This is Anthropic's own shape — their
 * manifest points at `~/.claude/chrome/chrome-native-host`, 155 bytes of
 * `exec <binary> --chrome-native-host` — split one level further so that even
 * the wrapper does not have to be rewritten.
 *
 * ══ WHY THE RELAY IS A SEPARATE BINARY ══
 *
 * `forge.config.ts` sets `RunAsNode: false`, so in a packaged build the Atlarix
 * binary cannot run a script as Node at all. See `native/atlarix-bridge` — the
 * failure that design avoids appears only after packaging, which is the worst
 * possible time to find it.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The host name, which Chrome constrains: lowercase alphanumerics, underscores
 * and dots only, and it must equal the manifest's `name` AND the filename.
 * A capital letter here is refused by Chrome with no useful message.
 */
export const BRIDGE_HOST_NAME = "dev.atlarix.bridge";

/**
 * The extension allowed to open the port.
 *
 * THE TRAILING SLASH IS LOAD-BearING and is the single most likely typo in this
 * file: `chrome-extension://<id>` without it silently matches nothing, and the
 * connection is refused as though the host were not installed. Pinned by a test
 * that also derives the id from `packages/extension/manifest.json`'s `key`, so
 * neither the id nor the slash is taken on trust.
 */
export const BRIDGE_EXTENSION_ID = "fkoacefbjjjhjceidagdajkgclfjacbe";
export const BRIDGE_ALLOWED_ORIGIN = `chrome-extension://${BRIDGE_EXTENSION_ID}/`;

/**
 * Where a user without the extension goes to get it.
 *
 * DERIVED, never a second literal. The id appears once in this codebase and
 * everything that needs it — the allowed origin, the host manifest, this link —
 * is built from that one constant, so a re-publish under a different id cannot
 * leave a stale URL pointing at someone else's extension.
 */
export const CHROME_STORE_URL = `https://chromewebstore.google.com/detail/${BRIDGE_EXTENSION_ID}`;

/** Derive a Chrome extension id from a manifest `key`, for the pinning test. */
export function extensionIdFromKey(base64Key: string): string {
  const digest = createHash("sha256")
    .update(Buffer.from(base64Key, "base64"))
    .digest("hex")
    .slice(0, 32);
  // Chrome's "mpdecimal" alphabet: hex nibbles 0-f map to a-p.
  return [...digest].map((c) => "abcdefghijklmnop"[parseInt(c, 16)]).join("");
}

/**
 * Where the desktop listens.
 *
 * NOT under `userData`, and that is not a style choice: `sun_path` is 104 bytes
 * on macOS, and a bind to a longer path fails with EINVAL — which a user with a
 * long name or a synced home directory would hit and nobody else ever would.
 * `/tmp/atlarix-bridge-<uid>.sock` is ~30 characters on any machine.
 *
 * The uid is in the name so two accounts on one machine do not collide, and the
 * socket is chmod 0600 so the filesystem is the whole access control — there is
 * no port to discover, nothing portscannable, no bearer token to leak, and no
 * macOS "accept incoming connections" prompt.
 */
export function bridgeSocketPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    // Windows has no unix sockets in Node's `net` server API; a named pipe is
    // the idiomatic equivalent and carries the same "local only" property.
    return `\\\\.\\pipe\\atlarix-bridge-${process.env.USERNAME ?? "user"}`;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `/tmp/atlarix-bridge-${uid}.sock`;
}

export function bridgeHome(home: string = os.homedir()): string {
  return path.join(home, ".atlarix", "chrome");
}

export function wrapperPath(
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return path.join(
    bridgeHome(home),
    platform === "win32" ? "atlarix-native-host.cmd" : "atlarix-native-host",
  );
}

export function hostEnvPath(home: string = os.homedir()): string {
  return path.join(bridgeHome(home), "host.env");
}

/**
 * Every browser profile directory that reads native messaging manifests.
 *
 * All Chromium forks, one build. Chrome, Brave and Edge all carry byte-identical
 * copies on a machine with Anthropic's extension installed, which is the shape
 * being copied. Writing to a browser that is not installed is harmless — the
 * directory is created and never read — and is cheaper than probing for each
 * one, which would miss a browser installed after Atlarix.
 */
export function manifestDirs(
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const suffix = "NativeMessagingHosts";
  if (platform === "darwin") {
    const support = path.join(home, "Library", "Application Support");
    return [
      path.join(support, "Google", "Chrome", suffix),
      path.join(support, "Chromium", suffix),
      path.join(support, "BraveSoftware", "Brave-Browser", suffix),
      path.join(support, "Microsoft Edge", suffix),
      path.join(support, "Vivaldi", suffix),
      path.join(support, "Google", "Chrome Beta", suffix),
    ];
  }
  if (platform === "win32") {
    // On Windows the manifest is found through the registry rather than a
    // well-known directory, so the file may live anywhere; the registry keys
    // (`windowsRegistryKeys`) are written by `installNativeHost`.
    return [bridgeHome(home)];
  }
  const config = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return [
    path.join(config, "google-chrome", suffix),
    path.join(config, "chromium", suffix),
    path.join(config, "BraveSoftware", "Brave-Browser", suffix),
    path.join(config, "microsoft-edge", suffix),
    path.join(config, "vivaldi", suffix),
  ];
}

/**
 * The per-browser registry keys Chromium reads on Windows. Each key's DEFAULT
 * value is the absolute path to the host manifest.
 *
 * WINDOWS HAS NO MANIFEST DIRECTORY — THE KEY IS THE WHOLE LOOKUP. Until
 * v14.52.0 nothing wrote these, so the bridge had never worked on Windows: the
 * manifest sat in `~/.atlarix/chrome` and no browser knew to look there.
 * HKCU, so no elevation is needed; every fork is written for the same reason
 * `manifestDirs` writes every fork on macOS and Linux.
 */
export function windowsRegistryKeys(): string[] {
  const tail = `NativeMessagingHosts\\${BRIDGE_HOST_NAME}`;
  return [
    `HKCU\\Software\\Google\\Chrome\\${tail}`,
    `HKCU\\Software\\Chromium\\${tail}`,
    `HKCU\\Software\\Microsoft\\Edge\\${tail}`,
    `HKCU\\Software\\BraveSoftware\\Brave-Browser\\${tail}`,
    `HKCU\\Software\\Vivaldi\\${tail}`,
  ];
}

/**
 * `reg.exe` arguments that set `key`'s default value to `manifestPath`.
 *
 * `reg.exe` rather than a native module: no new dependency, and it is an
 * EXTERNAL process — in the MSIX build it writes through the package's
 * registry virtualization unless the key is excluded, which is why the
 * package lists exactly `windowsRegistryKeys()` as `virtualization:ExcludedKey`
 * (Windows 11; see build/msix/AppxManifest.template.xml).
 */
export function regAddArgs(key: string, manifestPath: string): string[] {
  return ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"];
}

/** Runs one `reg.exe` invocation. Injected so tests never touch a registry. */
export type RegRunner = (args: string[]) => Promise<void>;

const runRegExe: RegRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile("reg", args, { windowsHide: true, timeout: 10_000 }, (err) =>
      err ? reject(err) : resolve(),
    );
  });

/**
 * Where the relay is copied on Windows.
 *
 * The packaged relay lives under `C:\Program Files\WindowsApps`, which is
 * ACL-restricted: a process outside the package (Chrome, launching the host)
 * cannot rely on executing from there. A copy beside the wrapper, in the
 * user's own profile, has no such question.
 *
 * ══ NAMED BY CONTENT, BECAUSE A RUNNING EXE CANNOT BE REPLACED ══
 *
 * Windows locks an executable's file while any process runs it, and Chrome
 * keeps a relay running for as long as its port is up — which, with the
 * extension reconnecting on every disconnect, is effectively always. One fixed
 * name meant an update could never land: the copy failed on the lock, the old
 * binary stayed, and 14.52.1's pipe fix sat unused behind 14.52.0's deadlocked
 * relay. A name derived from the bytes is never the file being run by an older
 * relay, so the new one is always written beside it rather than over it.
 */
export function windowsRelayCopyPath(
  home: string = os.homedir(),
  contentTag?: string,
): string {
  const name = contentTag ? `atlarix-bridge-${contentTag}.exe` : "atlarix-bridge.exe";
  return path.join(bridgeHome(home), name);
}

/** First 12 hex of the relay's SHA-256 — plenty to tell two builds apart. */
async function relayContentTag(relayPath: string): Promise<string> {
  const bytes = await fs.readFile(relayPath);
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

/**
 * Put the relay at its content-addressed path and remove every other copy.
 *
 * Written to a temp name and renamed, so Chrome can never spawn a half-written
 * exe. Old copies are removed best-effort: one still running is locked, stays
 * this launch, and goes on the next.
 */
async function placeWindowsRelay(relayPath: string, home: string): Promise<string> {
  const target = windowsRelayCopyPath(home, await relayContentTag(relayPath));
  const present = await fs
    .access(target)
    .then(() => true)
    .catch(() => false);
  if (!present) {
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.copyFile(relayPath, tmp);
    await fs.rename(tmp, target);
  }

  const dir = bridgeHome(home);
  const keep = path.basename(target);
  for (const entry of await fs.readdir(dir).catch(() => [] as string[])) {
    if (entry === keep || !/^atlarix-bridge.*\.(exe|tmp)$/i.test(entry)) continue;
    await fs.rm(path.join(dir, entry), { force: true }).catch(() => {});
  }
  return target;
}

export interface HostManifest {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
}

export function hostManifest(wrapper: string): HostManifest {
  return {
    name: BRIDGE_HOST_NAME,
    description: "Atlarix desktop bridge",
    path: wrapper,
    type: "stdio",
    allowed_origins: [BRIDGE_ALLOWED_ORIGIN],
  };
}

/**
 * The wrapper, which must be byte-stable forever.
 *
 * `exec` rather than a plain call so the relay REPLACES this shell rather than
 * running as its child: Chrome kills the process it spawned, and a shell that
 * lingered between Chrome and the relay would leave an orphan holding the
 * socket open every time a port closed.
 *
 * `set -a` exports everything `host.env` defines without repeating each name,
 * so adding a variable later is a one-line change to a file this wrapper never
 * needs to know about.
 */
export function wrapperScript(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    // `@echo off` FIRST. Without it cmd echoes each line to stdout, and stdout
    // is the framed protocol — the echo lands in front of the first length
    // prefix and desynchronises the stream permanently.
    return [
      "@echo off",
      "setlocal",
      'for /f "usebackq tokens=1,* delims==" %%a in ("%~dp0host.env") do set "%%a=%%b"',
      'if not defined ATLARIX_BRIDGE_RELAY exit /b 0',
      '"%ATLARIX_BRIDGE_RELAY%" --socket "%ATLARIX_BRIDGE_SOCKET%"',
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    "# Atlarix native messaging host. Written by the desktop app; do not edit.",
    "# Byte-stable on purpose: every browser's manifest points here by absolute",
    "# path, so this file changing name or location would break every profile.",
    "# What moves between versions is host.env, next to this file.",
    'set -a',
    '. "$(dirname "$0")/host.env" 2>/dev/null || exit 0',
    'set +a',
    '[ -n "$ATLARIX_BRIDGE_RELAY" ] || exit 0',
    'exec "$ATLARIX_BRIDGE_RELAY" --socket "$ATLARIX_BRIDGE_SOCKET"',
    "",
  ].join("\n");
}

export function hostEnvContents(relay: string, socket: string): string {
  return [
    "# Written by Atlarix on every launch. Safe to delete; it will come back.",
    `ATLARIX_BRIDGE_RELAY=${relay}`,
    `ATLARIX_BRIDGE_SOCKET=${socket}`,
    "",
  ].join("\n");
}

export interface InstallResult {
  wrapper: string;
  hostEnv: string;
  manifests: string[];
  /** Directories that could not be written, with the reason. Never thrown. */
  skipped: { dir: string; reason: string }[];
  /** Windows only: registry keys written. */
  registryKeys?: string[];
  /** Nothing was written: a scratch profile (ATLARIX_USER_DATA_DIR) installing into the real home. */
  scratchProfile?: true;
}

/**
 * Write the wrapper, the env file and one manifest per browser.
 *
 * IDEMPOTENT AND RUN ON EVERY LAUNCH. That is what keeps an app update, a move
 * to a different folder, or a user who installed Brave last week working
 * without anyone thinking about it.
 *
 * NEVER THROWS. A browser directory that cannot be written is one browser that
 * will not find the bridge, not a reason to fail startup — the desktop app has
 * to open whether or not Chrome is even installed.
 */
export async function installNativeHost(opts: {
  relayPath: string;
  socketPath?: string;
  home?: string;
  platform?: NodeJS.Platform;
  /** Windows registry writer — defaults to `reg.exe`. */
  runReg?: RegRunner;
}): Promise<InstallResult> {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const socket = opts.socketPath ?? bridgeSocketPath(platform);

  // A scratch profile (QA, tests) never rewrites the person's real browser
  // host: scratch CLI runs rewrote ~/.atlarix/chrome (item 8, 2026-10-22).
  // Real users never set ATLARIX_USER_DATA_DIR. An explicit `home` is an
  // install the caller asked for, into that folder.
  if (process.env.ATLARIX_USER_DATA_DIR && !opts.home) {
    return {
      wrapper: wrapperPath(home, platform),
      hostEnv: hostEnvPath(home),
      manifests: [],
      skipped: [],
      scratchProfile: true,
    };
  }

  const dir = bridgeHome(home);
  await fs.mkdir(dir, { recursive: true });

  const wrapper = wrapperPath(home, platform);
  await fs.writeFile(wrapper, wrapperScript(platform), "utf8");
  if (platform !== "win32") {
    // The executable bit, every time. A wrapper written without it is refused
    // by Chrome with the same message as one that does not exist.
    await fs.chmod(wrapper, 0o755);
  }

  const skipped: { dir: string; reason: string }[] = [];

  // Windows: run the relay from a content-addressed copy in the user's profile
  // (see `windowsRelayCopyPath`). If the copy cannot be made, run the packaged
  // relay directly — NEVER fall back to whatever copy is already there, which is
  // by definition an older build, and was once a deadlocking one.
  let relay = opts.relayPath;
  if (platform === "win32") {
    try {
      relay = await placeWindowsRelay(opts.relayPath, home);
    } catch (err) {
      skipped.push({
        dir: bridgeHome(home),
        reason: `relay copy failed, using the packaged relay: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const envFile = hostEnvPath(home);
  await fs.writeFile(envFile, hostEnvContents(relay, socket), "utf8");
  // 0600: it names a socket that accepts commands for this user's browser.
  await fs.chmod(envFile, 0o600).catch(() => {});

  const body = `${JSON.stringify(hostManifest(wrapper), null, 2)}\n`;
  const manifests: string[] = [];

  for (const target of manifestDirs(home, platform)) {
    const file = path.join(target, `${BRIDGE_HOST_NAME}.json`);
    try {
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(file, body, "utf8");
      manifests.push(file);
    } catch (err) {
      skipped.push({
        dir: target,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (platform !== "win32") {
    return { wrapper, hostEnv: envFile, manifests, skipped };
  }

  // Windows: point every fork's registry key at the manifest. Without this no
  // browser finds the host at all.
  const manifestFile = manifests[0];
  const registryKeys: string[] = [];
  if (manifestFile) {
    const runReg = opts.runReg ?? runRegExe;
    for (const key of windowsRegistryKeys()) {
      try {
        await runReg(regAddArgs(key, manifestFile));
        registryKeys.push(key);
      } catch (err) {
        skipped.push({
          dir: key,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { wrapper, hostEnv: envFile, manifests, skipped, registryKeys };
}
