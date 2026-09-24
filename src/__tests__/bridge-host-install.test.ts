/**
 * Installing the native messaging host.
 *
 * EVERY MISTAKE IN THIS FILE HAS THE SAME SYMPTOM — "Specified native messaging
 * host not found", or silence — and none of them can be told apart from "the
 * user has not installed the desktop app". They are therefore pinned rather
 * than eyeballed:
 *
 *  - **The trailing slash on `allowed_origins`.** `chrome-extension://<id>`
 *    without it matches nothing. Chrome refuses the connection exactly as
 *    though the host were absent.
 *  - **The extension id**, derived here from `packages/extension/manifest.json`'s
 *    own `key` rather than copied, so a rebuilt key cannot leave this file
 *    pointing at an extension that no longer exists.
 *  - **The executable bit** on the wrapper. Chrome's message for a
 *    non-executable host is the same as for a missing one.
 *  - **`@echo off`** on the Windows wrapper. Without it cmd echoes each line to
 *    stdout, and stdout IS the framed protocol — the echo lands in front of the
 *    first length prefix and desynchronises the stream permanently.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  BRIDGE_ALLOWED_ORIGIN,
  BRIDGE_EXTENSION_ID,
  BRIDGE_HOST_NAME,
  bridgeSocketPath,
  extensionIdFromKey,
  hostManifest,
  installNativeHost,
  manifestDirs,
  regAddArgs,
  windowsRegistryKeys,
  windowsRelayCopyPath,
  wrapperScript,
} from "@/lib/bridge/host-install";

async function tempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "atlarix-bridge-home-"));
}

/**
 * Windows has no POSIX permission bits.
 *
 * `fs.chmod` there sets only the read-only flag, and `stat().mode` comes back
 * `0o666` for an ordinary file — so `mode & 0o111` is 0 and an exact `0o600`
 * never matches, however correct the code is. `build-windows` is the ONLY CI job
 * that runs the suite on Windows, which is what makes this class of assertion
 * pass everywhere a developer looks and fail exactly once, in the release.
 *
 * The behaviour these two pin is real on the platforms that have it, so they are
 * skipped rather than weakened.
 */
const IS_WINDOWS = process.platform === "win32";

describe("the extension it will talk to", () => {
  it("is derived from the extension's OWN manifest key, not copied", async () => {
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(process.cwd(), "packages/extension/manifest.json"),
        "utf8",
      ),
    ) as { key: string };

    expect(extensionIdFromKey(manifest.key)).toBe(BRIDGE_EXTENSION_ID);
    expect(BRIDGE_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
  });

  it("ends the origin with a slash, which is the whole grant", () => {
    // Without it Chrome silently matches no extension at all.
    expect(BRIDGE_ALLOWED_ORIGIN).toBe(`chrome-extension://${BRIDGE_EXTENSION_ID}/`);
    expect(BRIDGE_ALLOWED_ORIGIN.endsWith("/")).toBe(true);
  });

  it("uses a host name Chrome will accept", () => {
    // Lowercase alphanumerics, underscores and dots only; anything else is
    // refused with no useful message.
    expect(BRIDGE_HOST_NAME).toMatch(/^[a-z0-9._]+$/);
  });
});

describe("the manifest", () => {
  it("names the wrapper, the type and exactly one origin", () => {
    const manifest = hostManifest("/Users/x/.atlarix/chrome/atlarix-native-host");
    expect(manifest).toEqual({
      name: BRIDGE_HOST_NAME,
      description: "Atlarix desktop bridge",
      path: "/Users/x/.atlarix/chrome/atlarix-native-host",
      type: "stdio",
      allowed_origins: [BRIDGE_ALLOWED_ORIGIN],
    });
  });
});

describe("installing", () => {
  it("writes a manifest into every Chromium fork's directory", async () => {
    const home = await tempHome();
    const result = await installNativeHost({
      relayPath: "/opt/Atlarix/atlarix-bridge",
      socketPath: "/tmp/atlarix-bridge-501.sock",
      home,
      platform: "darwin",
    });

    expect(result.manifests.length).toBe(manifestDirs(home, "darwin").length);
    const written = JSON.parse(await fs.readFile(result.manifests[0]!, "utf8")) as {
      path: string;
      allowed_origins: string[];
    };
    expect(written.allowed_origins).toEqual([BRIDGE_ALLOWED_ORIGIN]);
    expect(written.path).toBe(result.wrapper);

    // Named for the host, because Chrome looks the file up BY NAME.
    for (const file of result.manifests) {
      expect(path.basename(file)).toBe(`${BRIDGE_HOST_NAME}.json`);
    }
  });

  it.skipIf(IS_WINDOWS)("makes the wrapper executable", async () => {
    const home = await tempHome();
    const result = await installNativeHost({
      relayPath: "/opt/Atlarix/atlarix-bridge",
      home,
      platform: "darwin",
    });
    const mode = (await fs.stat(result.wrapper)).mode & 0o777;
    expect(mode & 0o111).toBeTruthy();
  });

  it("keeps the real paths OUT of the wrapper, so an update rewrites one file", async () => {
    // The manifest's `path` is read by Chrome at spawn time and must stay valid
    // across updates and across the app being moved. So the wrapper is
    // byte-stable and only host.env changes.
    const home = await tempHome();
    const first = await installNativeHost({
      relayPath: "/Applications/Atlarix.app/v1/atlarix-bridge",
      home,
      platform: "darwin",
    });
    const wrapperV1 = await fs.readFile(first.wrapper, "utf8");
    const manifestV1 = await fs.readFile(first.manifests[0]!, "utf8");

    const second = await installNativeHost({
      relayPath: "/Applications/Atlarix.app/v2-somewhere-else/atlarix-bridge",
      home,
      platform: "darwin",
    });

    expect(await fs.readFile(second.wrapper, "utf8")).toBe(wrapperV1);
    expect(await fs.readFile(second.manifests[0]!, "utf8")).toBe(manifestV1);
    // Only this moved.
    const env = await fs.readFile(second.hostEnv, "utf8");
    expect(env).toContain("v2-somewhere-else");
    expect(wrapperV1).not.toContain("v2-somewhere-else");
    expect(wrapperV1).not.toContain("/Applications/Atlarix.app/v1");
  });

  it("is idempotent, because it runs on every launch", async () => {
    const home = await tempHome();
    const a = await installNativeHost({ relayPath: "/opt/r", home, platform: "darwin" });
    const b = await installNativeHost({ relayPath: "/opt/r", home, platform: "darwin" });
    expect(b.manifests).toEqual(a.manifests);
    expect(b.skipped).toEqual([]);
  });

  it.skipIf(IS_WINDOWS)("locks down host.env, which names a socket that accepts commands", async () => {
    const home = await tempHome();
    const result = await installNativeHost({ relayPath: "/opt/r", home, platform: "darwin" });
    expect((await fs.stat(result.hostEnv)).mode & 0o777).toBe(0o600);
  });
});

/**
 * WINDOWS FINDS A NATIVE HOST ONLY THROUGH THE REGISTRY. Until v14.52.0 nothing
 * wrote a key, so the bridge had never worked there — and no test noticed,
 * because every test ran with a manifest DIRECTORY, which Windows does not
 * read. These run with a fake `reg.exe` so they pass on any OS and never touch
 * a real registry.
 */
describe("installing on Windows", () => {
  async function fakeRelay(dir: string): Promise<string> {
    const relay = path.join(dir, "packaged-atlarix-bridge.exe");
    await fs.writeFile(relay, "relay-bytes");
    return relay;
  }

  it("points every fork's HKCU key at the manifest", async () => {
    const home = await tempHome();
    const calls: string[][] = [];
    const result = await installNativeHost({
      relayPath: await fakeRelay(home),
      socketPath: "\\\\.\\pipe\\atlarix-bridge-me",
      home,
      platform: "win32",
      runReg: async (args) => {
        calls.push(args);
      },
    });

    const manifest = result.manifests[0]!;
    expect(result.registryKeys).toEqual(windowsRegistryKeys());
    expect(calls).toEqual(windowsRegistryKeys().map((k) => regAddArgs(k, manifest)));
    // Chrome, Edge and Brave at minimum — the browsers the product names.
    const keys = windowsRegistryKeys().join("\n");
    expect(keys).toContain("Google\\Chrome\\NativeMessagingHosts\\dev.atlarix.bridge");
    expect(keys).toContain("Microsoft\\Edge\\NativeMessagingHosts");
    expect(keys).toContain("BraveSoftware\\Brave-Browser\\NativeMessagingHosts");
    for (const k of windowsRegistryKeys()) expect(k.startsWith("HKCU\\")).toBe(true);
  });

  it("sets the key's DEFAULT value, which is where Chrome reads the path", () => {
    expect(regAddArgs("HKCU\\X", "C:\\m.json")).toEqual([
      "add",
      "HKCU\\X",
      "/ve",
      "/t",
      "REG_SZ",
      "/d",
      "C:\\m.json",
      "/f",
    ]);
  });

  it("runs the relay from a copy in the user's profile, not from WindowsApps", async () => {
    const home = await tempHome();
    const result = await installNativeHost({
      relayPath: await fakeRelay(home),
      home,
      platform: "win32",
      runReg: async () => {},
    });
    const copy = windowsRelayCopyPath(home);
    expect(await fs.readFile(copy, "utf8")).toBe("relay-bytes");
    const env = await fs.readFile(result.hostEnv, "utf8");
    expect(env).toContain(`ATLARIX_BRIDGE_RELAY=${copy}`);
  });

  it("a registry failure is recorded, never thrown — the app must still open", async () => {
    const home = await tempHome();
    const result = await installNativeHost({
      relayPath: await fakeRelay(home),
      home,
      platform: "win32",
      runReg: async () => {
        throw new Error("Access is denied.");
      },
    });
    expect(result.registryKeys).toEqual([]);
    expect(result.skipped.some((s) => s.reason.includes("Access is denied"))).toBe(
      true,
    );
  });

  it("writes no registry keys off Windows", async () => {
    const home = await tempHome();
    let called = false;
    const result = await installNativeHost({
      relayPath: "/opt/r",
      home,
      platform: "darwin",
      runReg: async () => {
        called = true;
      },
    });
    expect(called).toBe(false);
    expect(result.registryKeys).toBeUndefined();
  });
});

describe("the wrapper script", () => {
  it("execs so no shell is left between Chrome and the relay", () => {
    // A lingering shell would orphan itself around the socket every time a port
    // closed, because Chrome kills the process it spawned and nothing else.
    const script = wrapperScript("darwin");
    expect(script).toMatch(/^#!\/bin\/sh/);
    expect(script).toContain('exec "$ATLARIX_BRIDGE_RELAY"');
  });

  it("exits quietly when host.env is missing rather than erroring onto stdout", () => {
    // Anything on stdout that is not a frame desynchronises the protocol.
    const script = wrapperScript("darwin");
    expect(script).toContain("|| exit 0");
  });

  it("starts the Windows wrapper with @echo off, on the FIRST line", () => {
    const script = wrapperScript("win32");
    expect(script.split("\r\n")[0]).toBe("@echo off");
  });
});

describe("where the desktop listens", () => {
  it("is short enough for sun_path, which is 104 bytes on macOS", () => {
    // A bind to a longer path fails with EINVAL, which a user with a long name
    // would hit and nobody else ever would — so it is NOT under userData.
    const socket = bridgeSocketPath("darwin");
    expect(socket.length).toBeLessThan(104);
    expect(socket.startsWith("/tmp/")).toBe(true);
  });

  it("is a named pipe on Windows, which has no unix sockets in net's server", () => {
    expect(bridgeSocketPath("win32")).toMatch(/^\\\\\.\\pipe\\/);
  });
});
