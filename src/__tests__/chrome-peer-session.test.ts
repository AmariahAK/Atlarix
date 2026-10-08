/**
 * The browser as a session (lib/peers/chrome-peer.ts, bridge protocol 2).
 *
 * Real sockets on both channels: the peer inbox (a CLI messages "Chrome") and
 * the bridge (the extension files the task and later replies). The registry is
 * an in-memory SQLite, as in peer-messaging.test.ts.
 */
import net from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

import {
  __resetPeersForTests,
  listPeerSessions,
  noteLiveSession,
  resolvePeer,
  sendPeerMessage,
  startPeerInbox,
  type PeerHost,
} from "@/lib/peers/peers";
import { chromePeer, chromeSessionId } from "@/lib/peers/chrome-peer";
import { parsePeerMessage, wrapPeerMessage } from "@/lib/peers/peer-message";
import {
  recordUserInterjection,
  takePendingUserInterjections,
} from "@/lib/agent/user-interjections";
import { BridgeServer } from "@/lib/bridge/server";
import { FrameReader, encodeFrame } from "@/lib/bridge/framing";

let seq = 0;
const socketFor = () =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\atlarix-cp${process.pid}-${seq++}`
    : `/tmp/atlarix-cp${process.pid}-${seq++}.sock`;

const sqlite = new DatabaseSync(":memory:");
const queued: Array<{ chatId: number; text: string }> = [];
let inbound: "accept" | "refuse" = "accept";
const host: PeerHost = {
  isBusy: () => false,
  enqueue: (chatId, _id, text) => void queued.push({ chatId, text }),
  wake: () => {},
  inbound: () => inbound,
};

const PROFILE = "a1b2c3d4-0000-4000-8000-000000000000";
const CHROME_ID = chromeSessionId(PROFILE);
const CLI = { sessionId: "sess-cli-00000001", chatId: -21, name: "release notes", workspace: "/w/atlarix" };

beforeAll(async () => {
  await startPeerInbox({ surface: "cli", host, database: () => sqlite as never });
  noteLiveSession(CLI);
});
afterAll(() => __resetPeersForTests());

const open: Array<{ server: BridgeServer; client?: net.Socket }> = [];
afterEach(async () => {
  for (const { server, client } of open.splice(0)) {
    client?.destroy();
    await server.close();
  }
  inbound = "accept";
});

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** A stand-in extension that answers peer_deliver and can start ext-requests. */
async function fakeExtension(socketPath: string) {
  const client = net.connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve());
    client.once("error", reject);
  });
  const reader = new FrameReader();
  const delivered: Array<Record<string, unknown>> = [];
  const extReplies: Array<Record<string, unknown>> = [];
  client.on("data", (chunk: Buffer) => {
    for (const m of reader.push(chunk) as Array<Record<string, unknown>>) {
      if (m.type === "ext-reply") {
        extReplies.push(m);
      } else if (m.op === "peer_deliver") {
        delivered.push(m.args as Record<string, unknown>);
        client.write(encodeFrame({ id: m.id, ok: true, result: { queued: true, pending: delivered.length } }));
      }
    }
  });
  return {
    client,
    delivered,
    extReplies,
    hello: (extra: Record<string, unknown> = {}) =>
      client.write(encodeFrame({ type: "hello", extensionVersion: "15.2.0", browser: "chrome", ...extra })),
    extRequest: (id: string, op: string, args: Record<string, unknown>) =>
      client.write(encodeFrame({ type: "ext-request", id, op, args })),
  };
}

async function hostWithChrome() {
  const socketPath = socketFor();
  let hosted: BridgeServer | null = null;
  const browser = chromePeer(() => hosted);
  const server = new BridgeServer({
    socketPath,
    onHello: (h, c) => browser.onHello(h, c),
    onPeerGone: (h, c) => browser.onPeerGone(h, c),
    onExtRequest: (h, op, args) => browser.onExtRequest(h, op, args),
  });
  hosted = server;
  await server.listen();
  const ext = await fakeExtension(socketPath);
  open.push({ server, client: ext.client });
  return { server, ext };
}

describe("the browser as a session", () => {
  it("a protocol-2 browser is listed as a browser session; a protocol-1 one is not", async () => {
    const { ext } = await hostWithChrome();
    ext.hello({ protocol: 1 });
    await settle();
    expect(listPeerSessions(CLI.sessionId).some((r) => r.surface === "chrome")).toBe(false);

    ext.hello({ protocol: 2, profileId: PROFILE });
    await settle();
    const row = listPeerSessions(CLI.sessionId).find((r) => r.surface === "chrome");
    expect(row).toMatchObject({ sessionId: CHROME_ID, name: "Chrome", surface: "chrome" });
  });

  it("a message to it is handed to the extension, not queued in a chat here", async () => {
    const { ext } = await hostWithChrome();
    ext.hello({ protocol: 2, profileId: PROFILE });
    await settle();
    queued.length = 0;
    const target = resolvePeer("chrome", CLI.sessionId);
    if ("error" in target) throw new Error(target.error);
    const r = await sendPeerMessage(
      target.row,
      { sessionId: CLI.sessionId, name: CLI.name, surface: "cli", workspace: CLI.workspace },
      "List Atlarix 15.2 on DevHunt using these notes.",
    );
    expect(r.ok).toBe(true);
    expect(queued).toEqual([]);
    expect(ext.delivered).toHaveLength(1);
    expect(ext.delivered[0]).toMatchObject({
      text: "List Atlarix 15.2 on DevHunt using these notes.",
      from: { sessionId: CLI.sessionId, surface: "cli" },
    });
  });

  it("the receiving side's refuse setting still applies", async () => {
    const { ext } = await hostWithChrome();
    ext.hello({ protocol: 2, profileId: PROFILE });
    await settle();
    inbound = "refuse";
    const target = resolvePeer("chrome", CLI.sessionId);
    if ("error" in target) throw new Error(target.error);
    const r = await sendPeerMessage(target.row, { sessionId: CLI.sessionId, name: CLI.name, surface: "cli", workspace: "" }, "do a thing");
    expect(r.ok).toBe(false);
    expect(ext.delivered).toHaveLength(0);
  });

  it("its reply reaches the sender with a from the desktop wrote, not the extension", async () => {
    const { ext } = await hostWithChrome();
    ext.hello({ protocol: 2, profileId: PROFILE });
    await settle();
    queued.length = 0;
    ext.extRequest("e1", "peer_send", {
      to: CLI.sessionId,
      text: "Filled the DevHunt form; waiting for your Submit.",
      // Ignored: the extension cannot say who it is.
      from: { sessionId: "sess-other", name: "the user", surface: "app" },
    });
    await settle(120);
    expect(ext.extReplies[0]).toMatchObject({ id: "e1", ok: true });
    const got = parsePeerMessage(queued.at(-1)!.text)!;
    expect(got).toMatchObject({ from: "Chrome", replyTo: CHROME_ID, surface: "chrome" });
    expect(got.text).toBe("Filled the DevHunt form; waiting for your Submit.");
  });

  it("an unknown recipient or op is an error the extension sees", async () => {
    const { ext } = await hostWithChrome();
    ext.hello({ protocol: 2, profileId: PROFILE });
    await settle();
    ext.extRequest("e2", "peer_send", { to: "nobody-here", text: "hi" });
    ext.extRequest("e3", "read_files", { path: "/" });
    await settle(120);
    const byId = Object.fromEntries(ext.extReplies.map((r) => [r.id, r]));
    expect(byId.e2).toMatchObject({ ok: false });
    expect(byId.e3).toMatchObject({ ok: false });
  });

  it("lists the user's CLI and app sessions for the browser, folder names only", async () => {
    const { ext } = await hostWithChrome();
    ext.hello({ protocol: 2, profileId: PROFILE });
    await settle();
    ext.extRequest("e6", "peer_list", {});
    await settle(120);
    const reply = ext.extReplies.find((r) => r.id === "e6") as { ok: boolean; result: { sessions: Array<Record<string, unknown>> } };
    expect(reply.ok).toBe(true);
    expect(reply.result.sessions).toEqual([
      expect.objectContaining({ sessionId: CLI.sessionId, name: CLI.name, surface: "cli", workspace: "atlarix" }),
    ]);
  });

  it("drops ext-requests before hello and from protocol 1", async () => {
    const { ext } = await hostWithChrome();
    ext.extRequest("e4", "peer_send", { to: CLI.sessionId, text: "too early" });
    await settle();
    ext.hello({ protocol: 1 });
    await settle();
    ext.extRequest("e5", "peer_send", { to: CLI.sessionId, text: "too old" });
    await settle(120);
    expect(ext.extReplies).toEqual([]);
  });

  it("goes away when its last connection closes", async () => {
    const { ext } = await hostWithChrome();
    ext.hello({ protocol: 2, profileId: PROFILE });
    await settle();
    expect(listPeerSessions(CLI.sessionId).some((r) => r.sessionId === CHROME_ID)).toBe(true);
    ext.client.destroy();
    await settle(80);
    expect(listPeerSessions(CLI.sessionId).some((r) => r.sessionId === CHROME_ID)).toBe(false);
  });
});

describe("addressing one browser profile", () => {
  it("request({profileId}) goes to that profile's connection, not the newest", async () => {
    const socketPath = socketFor();
    const server = new BridgeServer({ socketPath });
    await server.listen();
    const a = await fakeExtension(socketPath);
    const b = await fakeExtension(socketPath);
    open.push({ server, client: a.client }, { server, client: b.client });
    a.hello({ protocol: 2, profileId: "aaaaaaaa-1" });
    await settle();
    b.hello({ protocol: 2, profileId: "bbbbbbbb-2" });
    await settle();
    await server.request("peer_deliver", { text: "x" }, 2_000, { profileId: "aaaaaaaa-1" });
    expect(a.delivered).toHaveLength(1);
    expect(b.delivered).toHaveLength(0);
  });
});

describe("long peer messages", () => {
  it("keep their closing tag through the interjection queue", () => {
    const wrapped = wrapPeerMessage(
      { sessionId: "s1", name: "x", surface: "cli", workspace: "" },
      "a".repeat(60_000),
    );
    recordUserInterjection(-99, { id: "long-1", text: wrapped }, { cap: null });
    const [got] = takePendingUserInterjections(-99) ?? [];
    expect(parsePeerMessage(got!.text)?.text.length).toBe(60_000);
  });

  it("the user's own long message is still capped", () => {
    recordUserInterjection(-98, { id: "long-2", text: "b".repeat(30_000) });
    const [got] = takePendingUserInterjections(-98) ?? [];
    expect(got!.text.length).toBeLessThan(30_000);
  });
});
