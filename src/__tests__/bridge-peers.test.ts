/**
 * One browser, several Atlarix processes (server.ts "one browser, several
 * Atlarix processes"; peer.ts): the desktop app and the CLI share the user's
 * browser. Over real sockets, as bridge-server.test.ts does:
 *
 *  - a peer sees the browser's status, and its request goes through the host
 *    to the browser and its reply comes back to the peer — not to the host;
 *  - the peer hears when the browser comes and goes;
 *  - when the host closes, the peer is told, and can take the main socket over.
 */
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { BridgeServer } from "@/lib/bridge/server";
import { BridgePeer, peersSocketPath } from "@/lib/bridge/peer";
import { FrameReader, encodeFrame } from "@/lib/bridge/framing";

let seq = 0;
const IS_WINDOWS = process.platform === "win32";
const socketFor = () =>
  IS_WINDOWS ? `\\\\.\\pipe\\atlarix-p${process.pid}-${seq++}` : `/tmp/atlarix-p${process.pid}-${seq++}.sock`;

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A stand-in for the extension: says hello, answers `echo` with its args. */
async function fakeBrowser(socketPath: string) {
  const client = net.connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", reject);
  });
  const reader = new FrameReader();
  client.on("data", (chunk: Buffer) => {
    for (const m of reader.push(chunk)) {
      const req = m as { id: string; op: string; args?: unknown };
      client.write(encodeFrame({ id: req.id, ok: true, result: { op: req.op, args: req.args } }));
    }
  });
  client.write(encodeFrame({ type: "hello", extensionVersion: "1.2.0", browser: "chrome" }));
  cleanup.push(() => client.destroy());
  return client;
}

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function host(socketPath: string) {
  const server = new BridgeServer({ socketPath, peersSocketPath: peersSocketPath(socketPath) });
  await server.listen();
  cleanup.push(() => server.close());
  return server;
}

describe("sharing the browser between Atlarix processes", () => {
  it("a peer's request reaches the browser through the host, and the reply comes back to the peer", async () => {
    const socketPath = socketFor();
    const server = await host(socketPath);
    await fakeBrowser(socketPath);
    await settle();

    const peer = new BridgePeer({ socketPath: peersSocketPath(socketPath) });
    await peer.connect();
    cleanup.push(() => peer.close());
    expect(peer.connected).toBe(true);
    expect(peer.activeHello).toMatchObject({ extensionVersion: "1.2.0" });

    // Both at once: each gets its own answer.
    const [fromPeer, fromHost] = await Promise.all([
      peer.request("echo", { who: "cli" }),
      server.request("echo", { who: "app" }),
    ]);
    expect(fromPeer).toEqual({ op: "echo", args: { client: "app", who: "cli" } });
    expect(fromHost).toEqual({ op: "echo", args: { client: "app", who: "app" } });
  });

  it("a peer hears the browser come and go", async () => {
    const socketPath = socketFor();
    await host(socketPath);
    const peer = new BridgePeer({ socketPath: peersSocketPath(socketPath) });
    await peer.connect();
    cleanup.push(() => peer.close());
    expect(peer.connected).toBe(false);

    const browser = await fakeBrowser(socketPath);
    await settle();
    expect(peer.connected).toBe(true);

    browser.destroy();
    await settle();
    expect(peer.connected).toBe(false);
    await expect(peer.request("echo")).rejects.toThrow(/no browser|did not answer|disconnected/);
  });

  it("when the host closes, the peer is told and can take the socket over", async () => {
    const socketPath = socketFor();
    const first = new BridgeServer({ socketPath, peersSocketPath: peersSocketPath(socketPath) });
    await first.listen();

    let hostGone = 0;
    const peer = new BridgePeer({ socketPath: peersSocketPath(socketPath), onHostGone: () => void hostGone++ });
    await peer.connect();
    await first.close();
    await settle();
    expect(hostGone).toBe(1);

    // The peer's process takes over: the main socket is free for it.
    const second = await host(socketPath);
    await fakeBrowser(socketPath);
    await settle();
    expect(second.connected).toBe(true);
    await peer.close();
  });

  it("a peer that closes on purpose does not try to take over", async () => {
    const socketPath = socketFor();
    await host(socketPath);
    let hostGone = 0;
    const peer = new BridgePeer({ socketPath: peersSocketPath(socketPath), onHostGone: () => void hostGone++ });
    await peer.connect();
    await peer.close();
    await settle();
    expect(hostGone).toBe(0);
  });

  it("a peer says which Atlarix it is, and the host passes that on to the browser", async () => {
    const socketPath = socketFor();
    await host(socketPath);
    await fakeBrowser(socketPath);
    await settle();
    const before = process.env.ATLARIX_SURFACE;
    process.env.ATLARIX_SURFACE = "cli";
    try {
      const peer = new BridgePeer({ socketPath: peersSocketPath(socketPath) });
      await peer.connect();
      cleanup.push(() => peer.close());
      expect(await peer.request("echo", {})).toEqual({ op: "echo", args: { client: "cli" } });
    } finally {
      if (before === undefined) delete process.env.ATLARIX_SURFACE;
      else process.env.ATLARIX_SURFACE = before;
    }
  });
});
