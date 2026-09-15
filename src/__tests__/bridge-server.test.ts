/**
 * The desktop's end of the bridge, driven over a real socket.
 *
 * A REAL `net` CONNECTION RATHER THAN A MOCK, because every property worth
 * having here is a property of the socket: partial chunks, replies arriving out
 * of order, a peer vanishing mid-request, a stale socket file left by a crash.
 * A fake that hands over whole messages in order would pass while proving none
 * of it.
 *
 * THE HEADLINE IS OUT-OF-ORDER CORRELATION. Two reads issued together come back
 * in whichever order the pages answer. Matching by arrival would swap the two
 * results silently, and the model would reason confidently about the wrong page
 * with nothing anywhere reporting an error.
 */

import net from "node:net";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { BridgeServer } from "@/lib/bridge/server";
import { FrameReader, encodeFrame } from "@/lib/bridge/framing";

/**
 * A listen address this platform actually has.
 *
 * WINDOWS HAS NO `/tmp` AND NO UNIX SOCKETS, and `build-windows` is the ONLY CI
 * job that runs the test suite on Windows — so a hardcoded POSIX path passes
 * locally, passes on the macOS and Linux jobs, and dies exactly once, in the
 * release. It did: `listen EACCES: permission denied /tmp/atlarix-t8216-7.sock`,
 * on the v14.46.0 tag run, after both macOS builds and Linux had gone green.
 *
 * On unix the path is short by necessity — `sun_path` is 104 bytes on macOS and
 * the OS temp dir already spends ~50 of them, which is why this is not
 * `os.tmpdir()`.
 */
let seq = 0;
const IS_WINDOWS = process.platform === "win32";
const socketFor = () =>
  IS_WINDOWS
    ? `\\\\.\\pipe\\atlarix-t${process.pid}-${seq++}`
    : `/tmp/atlarix-t${process.pid}-${seq++}.sock`;

const open: { server: BridgeServer; client?: net.Socket }[] = [];

afterEach(async () => {
  for (const { server, client } of open.splice(0)) {
    client?.destroy();
    await server.close();
  }
});

/** A stand-in for the extension: speaks the framing, answers what it is told. */
async function connectFakeExtension(
  socketPath: string,
  onRequest?: (req: { id: string; op: string; args?: unknown }, reply: (r: unknown) => void) => void,
) {
  const client = net.connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", reject);
  });

  const reader = new FrameReader();
  const seen: { id: string; op: string; args?: unknown }[] = [];
  client.on("data", (chunk: Buffer) => {
    for (const message of reader.push(chunk)) {
      const req = message as { id: string; op: string; args?: unknown };
      seen.push(req);
      onRequest?.(req, (body) => client.write(encodeFrame(body)));
    }
  });

  const hello = (extra: Record<string, unknown> = {}) =>
    client.write(encodeFrame({ type: "hello", extensionVersion: "1.1.0", browser: "chrome", ...extra }));

  return { client, seen, hello };
}

/** Let a write cross the socket. */
const settle = () => new Promise((r) => setTimeout(r, 30));

async function start(onHello?: (h: unknown) => void) {
  const socketPath = socketFor();
  const server = new BridgeServer({ socketPath, onHello: onHello as never });
  await server.listen();
  open.push({ server });
  return { server, socketPath };
}

describe("a browser connecting", () => {
  it("is not connected until it has said hello", async () => {
    const { server, socketPath } = await start();
    const ext = await connectFakeExtension(socketPath);
    await settle();
    // Connected at the socket level, but it has not identified itself — and a
    // request sent to a peer that never spoke could never be answered.
    expect(server.connected).toBe(false);

    ext.hello();
    await settle();
    expect(server.connected).toBe(true);
    expect(server.peerInfo[0]?.extensionVersion).toBe("1.1.0");
    ext.client.destroy();
  });

  it("refuses a request when nothing is connected, and says which way it dials", async () => {
    const { server } = await start();
    await expect(server.request("read_page")).rejects.toThrow(
      /the browser opens this connection, the app cannot open it/,
    );
  });
});

describe("requests and replies", () => {
  it("matches replies to requests by ID when they come back OUT OF ORDER", async () => {
    const { server, socketPath } = await start();
    const held: Array<{ id: string; reply: (r: unknown) => void }> = [];
    const ext = await connectFakeExtension(socketPath, (req, reply) => {
      held.push({ id: req.id, reply });
    });
    ext.hello();
    await settle();

    const first = server.request("read_page", { tab: 1 });
    const second = server.request("read_page", { tab: 2 });
    await settle();
    expect(held).toHaveLength(2);

    // The SECOND page answers first, which is the ordinary case when two tabs
    // are read together and one is heavier than the other.
    held[1]!.reply({ id: held[1]!.id, ok: true, result: "page two" });
    held[0]!.reply({ id: held[0]!.id, ok: true, result: "page one" });

    await expect(first).resolves.toBe("page one");
    await expect(second).resolves.toBe("page two");
    ext.client.destroy();
  });

  it("carries the op and args through untouched", async () => {
    const { server, socketPath } = await start();
    const ext = await connectFakeExtension(socketPath, (req, reply) =>
      reply({ id: req.id, ok: true, result: req.args }),
    );
    ext.hello();
    await settle();

    await expect(server.request("click", { ref: "e12", why: "héllo 🌍" })).resolves.toEqual({
      ref: "e12",
      why: "héllo 🌍",
    });
    expect(ext.seen[0]?.op).toBe("click");
    ext.client.destroy();
  });

  it("surfaces the extension's own failure rather than inventing one", async () => {
    const { server, socketPath } = await start();
    const ext = await connectFakeExtension(socketPath, (req, reply) =>
      reply({ id: req.id, ok: false, error: "that tab was closed" }),
    );
    ext.hello();
    await settle();
    await expect(server.request("click", { ref: "e1" })).rejects.toThrow("that tab was closed");
    ext.client.destroy();
  });

  it("refuses a request over Chrome's 1 MB limit instead of letting it vanish", async () => {
    // Chrome DROPS an oversized message to an extension with no error at all,
    // so the caller would wait out the full timeout learning nothing.
    const { server, socketPath } = await start();
    const ext = await connectFakeExtension(socketPath);
    ext.hello();
    await settle();

    await expect(
      server.request("fill", { value: "x".repeat(1_200_000) }),
    ).rejects.toThrow(/over Chrome's 1 MB limit/);
    ext.client.destroy();
  });
});

describe("when the browser goes away", () => {
  it("fails anything still waiting instead of hanging forever", async () => {
    const { server, socketPath } = await start();
    const ext = await connectFakeExtension(socketPath, () => {
      /* accept the request and never answer */
    });
    ext.hello();
    await settle();

    const pending = server.request("read_page");
    await settle();
    ext.client.destroy();

    await expect(pending).rejects.toThrow(/disconnected before it answered/);
  });

  it("times out with the op named, so the log says what was waiting", async () => {
    const { server, socketPath } = await start();
    const ext = await connectFakeExtension(socketPath, () => {});
    ext.hello();
    await settle();
    await expect(server.request("read_page", {}, 60)).rejects.toThrow(
      /did not answer "read_page"/,
    );
    ext.client.destroy();
  });
});

describe("the socket file", () => {
  // A named pipe is not a filesystem entry, so there is nothing to stat, write
  // or unlink — these two assert the UNIX cleanup path specifically. The
  // "already listening" case below is meaningful on both and is not skipped.
  it.skipIf(IS_WINDOWS)("is removed on close, and a stale one does not block the next launch", async () => {
    const socketPath = socketFor();
    const first = new BridgeServer({ socketPath });
    await first.listen();
    await expect(fs.stat(socketPath)).resolves.toBeTruthy();
    await first.close();

    // Simulate the crash case: the file is back, with nothing behind it.
    await fs.writeFile(socketPath, "");
    const second = new BridgeServer({ socketPath });
    await expect(second.listen()).resolves.toBeUndefined();
    open.push({ server: second });
  });

  it("refuses to steal the name from a live instance", async () => {
    const { socketPath } = await start();
    const second = new BridgeServer({ socketPath });
    await expect(second.listen()).rejects.toThrow(/already listening/);
  });
});
