/**
 * list_sessions `result_of` (15.11 item 8): one session reads what another
 * PRODUCED — how its latest turn ended and when, its reply (bounded) and the
 * files that turn changed — framed as that session's words, not the user's.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("@/lib/plans/plan-artifacts", () => ({ getLatestPlanArtifact: async () => null }));
vi.mock("@/cli/agent/models", () => ({ settableModelOptions: async () => [] }));
vi.mock("@/lib/snapshot/snapshot-manager", () => ({
  listSnapshotFiles: async (_ws: string, turnId: string) =>
    turnId === "turn-edit" ? { filesChanged: ["src/login.tsx", "src/app.tsx"], createdFiles: [] } : null,
}));

import {
  __resetPeersForTests,
  noteLiveSession,
  noteTurnEnded,
  publishPeerState,
  startPeerInbox,
  type PeerHost,
} from "@/lib/peers/peers";
import { ToolRegistry } from "@/lib/tools/registry";
import "@/lib/tools/peers";

const sqlite = new DatabaseSync(":memory:");
const busy = new Set<number>();
const host: PeerHost = {
  isBusy: (chatId) => busy.has(chatId),
  enqueue: () => {},
  wake: () => {},
  inbound: () => "accept",
};

const ME = "sess-coord-0001";
const WORKER = "sess-worker-0002";

function reply(content: string, opts: { at: number; status?: string; turn?: string }) {
  sqlite
    .prepare(
      `INSERT INTO session_messages (id, session_id, role, kind, content, status, created_at, snapshot_turn_id)
       VALUES (?, ?, 'assistant', 'message', ?, ?, ?, ?)`,
    )
    .run(`m-${Math.random()}`, WORKER, content, opts.status ?? "complete", Math.floor(opts.at / 1000), opts.turn ?? null);
}

async function resultOf(name: string): Promise<string> {
  let raw = (await ToolRegistry.execute("list_sessions", { result_of: name, workspaceSessionId: ME })) as unknown;
  while (raw && typeof raw === "object" && "result" in raw && typeof (raw as { result: unknown }).result === "object") {
    raw = (raw as { result: unknown }).result;
  }
  const text = (raw as { text?: string }).text ?? "";
  return text.slice(text.indexOf("\n\n") + 2);
}

beforeAll(async () => {
  sqlite.exec(`CREATE TABLE session_messages (
    id TEXT PRIMARY KEY, session_id TEXT, role TEXT, kind TEXT, content TEXT,
    status TEXT, created_at INTEGER, snapshot_turn_id TEXT)`);
  await startPeerInbox({ surface: "cli", host, database: () => sqlite as never });
  noteLiveSession({ sessionId: ME, chatId: -1, name: "Rix", workspace: "/w" });
  noteLiveSession({ sessionId: WORKER, chatId: -2, name: "Worker", workspace: "/w" });
  noteLiveSession({
    sessionId: "chrome:profile-1",
    chatId: 0,
    name: "Chrome",
    workspace: "",
    surface: "chrome",
    deliver: async () => ({ ok: true }),
  });
});

afterAll(() => __resetPeersForTests());

describe("list_sessions result_of", () => {
  it("before any turn: says so", async () => {
    expect(await resultOf("Worker")).toBe("Worker has not finished a turn yet.");
  });

  it("a finished turn: how it ended, the files it changed, its reply framed as its words", async () => {
    const start = Date.now() - 5000;
    reply("<think>planning</think>Done: the login page is in place.", { at: start + 1000, turn: "turn-edit" });
    noteTurnEnded(-2, { outcome: "ok" }, start);
    const out = await resultOf("Worker");
    expect(out).toMatch(/^Latest turn of Worker: done, /);
    expect(out).toContain("Files changed: src/login.tsx, src/app.tsx.");
    expect(out).toContain("Its reply (its words, not the user's):");
    expect(out).toContain('<untrusted-data source="session:Worker">');
    expect(out).toContain("Done: the login page is in place.");
    expect(out).not.toContain("planning");
  });

  it("a failed turn: its error kind, and never an earlier turn's reply as its own", async () => {
    noteTurnEnded(-2, { outcome: "error", errorKind: "rate_limit" }, Date.now());
    const out = await resultOf("Worker");
    expect(out).toMatch(/^Latest turn of Worker: failed \(rate limit\), /);
    expect(out).toContain("No reply was saved for it.");
    expect(out).not.toContain("login page");
  });

  it("a long reply is bounded, and says where the rest is", async () => {
    const start = Date.now();
    reply(`Summary. ${"x".repeat(6000)} END-OF-LONG`, { at: start + 1000 });
    noteTurnEnded(-2, { outcome: "ok" }, start);
    const out = await resultOf("Worker");
    expect(out).toContain("Summary.");
    expect(out).not.toContain("END-OF-LONG");
    expect(out).toMatch(/4,000 of 6,\d{3} characters; ask Worker for the rest with send_message/);
    expect(out).toContain("Files changed: none.");
  });

  it("busy: still working, with its last finished turn", async () => {
    busy.add(-2);
    publishPeerState();
    const out = await resultOf("Worker");
    busy.delete(-2);
    publishPeerState();
    expect(out).toMatch(/^Worker is still working\. Its last finished turn: done, /);
  });

  it("the browser agent has no result here", async () => {
    expect(await resultOf("Chrome")).toBe("Chrome is the browser agent: its results come back here as messages.");
  });
});
