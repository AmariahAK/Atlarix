/**
 * `requestChrome` against a REAL BridgeServer over a real socket.
 *
 * WHY THIS EXISTS ON TOP OF THE MOCKED SUITE. The defect this whole change
 * fixes is that `bridge()` had ZERO production callers — the transport was
 * built, tested and unreachable. A suite that mocks `bridge()` would pass just
 * as happily against that state, because it never asks whether the thing on the
 * other end is real. This wires the actual server to an actual peer and pushes
 * a request through the actual code path.
 *
 * The peer is a raw socket speaking the frame protocol rather than the
 * extension, because the extension's half is the one piece that cannot run
 * under vitest — and the protocol is the contract between them.
 */
import net from "node:net";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BridgeServer } from "@/lib/bridge/server";
import { FrameReader, encodeFrame } from "@/lib/bridge/framing";

let live: BridgeServer | null = null;
vi.mock("@/main/bridge-lifecycle", () => ({ bridge: () => live }));

import { requestChrome, chromeUnavailable, isChromeRefusal } from "@/lib/tools/browser-target";

// Windows has no unix sockets and `build-windows` is the only CI job that runs
// the suite there; `sun_path` is 104 bytes on macOS, hence the short path.
let seq = 0;
const IS_WINDOWS = process.platform === "win32";
const socketFor = () =>
  IS_WINDOWS
    ? `\\\\.\\pipe\\atlarix-bt${process.pid}-${seq++}`
    : `/tmp/atlarix-bt${process.pid}-${seq++}.sock`;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
  live = null;
});

/** A server with one connected peer that answers ops from `handlers`. */
async function withPeer(
  handlers: Record<string, (args: Record<string, unknown>) => unknown>,
) {
  const socketPath = socketFor();
  const server = new BridgeServer({ socketPath });
  await server.listen();
  live = server;

  const sock = net.createConnection(socketPath);
  await new Promise((r) => sock.once("connect", r));
  sock.write(encodeFrame({ type: "hello", browser: "chrome", extensionVersion: "1.0.1" }));

  const reader = new FrameReader();
  sock.on("data", (chunk) => {
    for (const frame of reader.push(chunk)) {
      const req = frame as { id: string; op: string; args?: Record<string, unknown> };
      const fn = handlers[req.op];
      if (!fn) {
        sock.write(
          encodeFrame({
            id: req.id,
            ok: false,
            error: `the browser extension has no bridged op "${req.op}". This build may be older than the desktop app asking.`,
          }),
        );
        continue;
      }
      sock.write(encodeFrame({ id: req.id, ok: true, result: fn(req.args ?? {}) }));
    }
  });

  // The server marks a peer connected on `hello`; give it a tick to arrive.
  for (let i = 0; i < 50 && !server.connected; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  cleanups.push(async () => {
    sock.destroy();
    await server.close();
    if (!IS_WINDOWS) await fs.rm(socketPath, { force: true });
  });
  return server;
}

describe("the desktop tool layer really reaches a connected peer", () => {
  it("round-trips a read through the real server", async () => {
    const server = await withPeer({
      read_page: (args) => ({
        tabId: args.tab_id ?? 42,
        url: "https://example.com/",
        text: "the page",
      }),
    });
    expect(server.connected).toBe(true);
    expect(chromeUnavailable()).toBeNull();

    const res = await requestChrome("read_page", { filter: "all" });
    expect(isChromeRefusal(res)).toBe(false);
    if (isChromeRefusal(res)) return;
    expect(res.result).toMatchObject({ url: "https://example.com/", text: "the page" });
  });

  it("turns an older extension's unknown-op refusal into the fix, over the real socket", async () => {
    await withPeer({});
    const res = await requestChrome("text", {});
    expect(isChromeRefusal(res)).toBe(true);
    if (!isChromeRefusal(res)) return;
    expect(res.error).toContain("older than this app");
  });

  it("refuses with the install link when nothing is connected", async () => {
    const socketPath = socketFor();
    const server = new BridgeServer({ socketPath });
    await server.listen();
    live = server;
    cleanups.push(async () => {
      await server.close();
      if (!IS_WINDOWS) await fs.rm(socketPath, { force: true });
    });

    const res = await requestChrome("read_page", {});
    expect(isChromeRefusal(res)).toBe(true);
    if (!isChromeRefusal(res)) return;
    expect(res.error).toContain("chromewebstore.google.com");
  });
});
