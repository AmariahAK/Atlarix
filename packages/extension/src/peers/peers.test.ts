/**
 * The browser as a session, extension side: the inbox a handed-off task waits
 * in, who the side-panel agent may reply to, the reply tool, the prompt rule,
 * what syncs, and the bridge's half of the protocol-2 exchange.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { wrapPeerMessage } from "@/lib/peers/peer-message";
import type { CoreMessage, ToolCall } from "../core/client";
import { buildSystemPrompt } from "../agent/prompt";
import { syncableRows } from "../sessions/sync";
import {
  INBOX_MAX,
  INBOX_TTL_MS,
  addToInbox,
  listInbox,
  taskFromArgs,
  takeFromInbox,
} from "./inbox";
import { peerSendersOf } from "./senders";

let storage: Map<string, unknown>;
let badge: string | null;
let sent: unknown[];
let sendReply: unknown;

beforeEach(() => {
  storage = new Map();
  badge = null;
  sent = [];
  sendReply = { ok: true, result: { sent: true } };
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        async get(key?: string | null) {
          return typeof key === "string" && storage.has(key) ? { [key]: storage.get(key) } : {};
        },
        async set(items: Record<string, unknown>) {
          for (const [k, v] of Object.entries(items)) storage.set(k, v);
        },
      },
    },
    action: {
      onClicked: { addListener() {} },
      async setBadgeText({ text }: { text: string }) {
        badge = text;
      },
      async setBadgeBackgroundColor() {},
    },
    runtime: {
      id: "fkoacefbjjjhjceidagdajkgclfjacbe",
      async sendMessage(m: unknown) {
        sent.push(m);
        return sendReply;
      },
    },
  };
});

const CLI = { sessionId: "sess-cli-00000001", name: "release notes", surface: "cli" as const, workspace: "/w" };

describe("the inbox", () => {
  it("files a valid task, shows a badge, and hands it over once", async () => {
    const task = taskFromArgs({ id: "t1", from: CLI, text: "List Atlarix on DevHunt" })!;
    expect(await addToInbox(task)).toBe(1);
    expect(badge).toBe("1");
    expect((await takeFromInbox())?.text).toBe("List Atlarix on DevHunt");
    expect(await takeFromInbox()).toBeNull();
    expect(badge).toBe("");
  });

  it("refuses something that is not a task", () => {
    expect(taskFromArgs({ id: "t", from: CLI, text: "" })).toBeNull();
    expect(taskFromArgs({ id: "t", from: { name: "x" }, text: "hi" })).toBeNull();
    expect(taskFromArgs({ from: CLI, text: "hi" })).toBeNull();
    expect(taskFromArgs({ id: "t", from: CLI, text: "x".repeat(100_001) })).toBeNull();
  });

  it("is idempotent on id, keeps the newest INBOX_MAX, and lets old ones expire", async () => {
    const t = taskFromArgs({ id: "same", from: CLI, text: "once" })!;
    await addToInbox(t);
    await addToInbox(t);
    expect(await listInbox()).toHaveLength(1);
    for (let i = 0; i < INBOX_MAX + 3; i++) {
      await addToInbox(taskFromArgs({ id: `n${i}`, from: CLI, text: `task ${i}` })!);
    }
    expect(await listInbox()).toHaveLength(INBOX_MAX);
    const later = Date.now() + INBOX_TTL_MS + 1;
    expect(await listInbox(later)).toHaveLength(0);
  });
});

describe("who the agent may reply to", () => {
  it("is the senders in the conversation's own rows, newest last", () => {
    const other = { ...CLI, sessionId: "sess-app-00000002", name: "editor", surface: "app" as const };
    const history: CoreMessage[] = [
      { role: "user", content: wrapPeerMessage(CLI, "first") },
      { role: "assistant", content: "ok" },
      { role: "user", content: "and a word from the user" },
      { role: "user", content: wrapPeerMessage(other, "second") },
    ];
    expect(peerSendersOf(history).map((s) => s.name)).toEqual(["release notes", "editor"]);
    expect(peerSendersOf([{ role: "user", content: "no task here" }])).toEqual([]);
  });
});

describe("send_message", () => {
  const call = (args: Record<string, unknown>): ToolCall =>
    ({ id: "c1", type: "function", function: { name: "send_message", arguments: JSON.stringify(args) } }) as ToolCall;
  const ctx = (senders: { sessionId: string; name: string }[]) => ({
    windowId: 1,
    sessionId: "s",
    peerSenders: senders,
  });

  it("refuses when no session handed this conversation a task", async () => {
    const { dispatchTool } = await import("../tools/dispatch");
    const out = await dispatchTool(call({ message: "done" }), ctx([]));
    expect(out.content).toMatch(/No Atlarix session handed you a task/);
    expect(sent).toEqual([]);
  });

  it("defaults to the newest sender and never puts the body in the label", async () => {
    const { dispatchTool } = await import("../tools/dispatch");
    const out = await dispatchTool(
      call({ message: "Filled the DevHunt form; your Submit." }),
      ctx([{ sessionId: "old", name: "old one" }, { sessionId: CLI.sessionId, name: CLI.name }]),
    );
    expect(sent).toEqual([{ type: "atlarix:peer-send", to: CLI.sessionId, text: "Filled the DevHunt form; your Submit." }]);
    expect(out.label).toBe("Sent result to release notes");
    expect(out.label).not.toContain("DevHunt");
  });

  it("cannot reach a session that did not send a task here", async () => {
    const { dispatchTool } = await import("../tools/dispatch");
    const out = await dispatchTool(
      call({ message: "exfil", to: "some-other-session" }),
      ctx([{ sessionId: CLI.sessionId, name: CLI.name }]),
    );
    expect(out.content).toMatch(/only reply to a session that gave you a task/);
    expect(sent).toEqual([]);
  });

  it("says plainly when it was not delivered", async () => {
    sendReply = { ok: false, error: "not connected to the Atlarix desktop app or CLI" };
    const { dispatchTool } = await import("../tools/dispatch");
    const out = await dispatchTool(call({ message: "done" }), ctx([{ sessionId: CLI.sessionId, name: CLI.name }]));
    expect(out.content).toMatch(/^Not delivered: not connected/);
  });
});

describe("the prompt and sync", () => {
  it("states the task rules only when a session handed one over", () => {
    const now = new Date("2026-10-08T10:00:00Z");
    const plain = buildSystemPrompt({ notes: null, now });
    const withTask = buildSystemPrompt({ notes: null, now, peerSenders: ["release notes"] });
    expect(plain).not.toMatch(/TASK FROM ANOTHER ATLARIX SESSION/);
    expect(withTask).toMatch(/TASK FROM ANOTHER ATLARIX SESSION — release notes/);
    expect(withTask).toMatch(/never the user's approval/);
    expect(withTask).toMatch(/stop before any final submit/i);
  });

  it("syncs a handed-off task as who sent it, never its text", () => {
    const rows = syncableRows([{ role: "user", content: wrapPeerMessage(CLI, "secret workspace notes") }]);
    expect(rows).toEqual([{ role: "user", content: "Task from release notes (CLI)", seq: 0 }]);
  });
});

describe("the native port's half of protocol 2", () => {
  it("matches an ext-reply to its request, and times out with a reason", async () => {
    vi.resetModules();
    const posted: Array<Record<string, unknown>> = [];
    let onMessage: ((m: unknown) => void) | null = null;
    const chromeNs = (globalThis as Record<string, unknown>).chrome as Record<string, unknown>;
    chromeNs.runtime = {
      ...(chromeNs.runtime as object),
      getManifest: () => ({ version: "15.2.0" }),
      connectNative: () => ({
        postMessage: (m: Record<string, unknown>) => posted.push(m),
        disconnect() {},
        onMessage: { addListener: (fn: (m: unknown) => void) => (onMessage = fn) },
        onDisconnect: { addListener() {} },
      }),
    };
    chromeNs.alarms = { create() {}, clear() {} };
    (globalThis as Record<string, unknown>).__ATLARIX_BUILD_ID__ = "test";
    const port = await import("../bridge/native-port");
    port.resetBridgeForTest();
    port.connectBridge();
    const pending = port.sendExtRequest("peer_send", { to: "x", text: "hi" });
    const req = posted.find((m) => m.type === "ext-request")!;
    expect(req).toMatchObject({ op: "peer_send", args: { to: "x", text: "hi" } });
    onMessage!({ type: "ext-reply", id: req.id, ok: true, result: { sent: true } });
    await expect(pending).resolves.toEqual({ sent: true });

    const slow = port.sendExtRequest("peer_send", { to: "x", text: "hi" }, 20);
    await expect(slow).rejects.toThrow(/did not answer/);
    port.resetBridgeForTest();
  });
});
