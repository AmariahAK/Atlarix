/**
 * A transport id is THIS process's (every Atlarix process numbers its own,
 * from -1), but `chat_sessions.stream_chat_id` is shared by every process that
 * opens the session. Trusting the column alone handed one session another's
 * transport (multi-process audit 1a, 2026-10-20):
 *
 *   CLI1 in folder F starts session X (transport -1, stored -1). CLI2 in F
 *   starts session Y (its own transport -1). CLI2 `/resume X`: allocate-
 *   transport found X's stored -1 among CLI2's transports and reused it, so
 *   X and Y shared one transport, and Y's pending approvals, job results and
 *   queued messages landed in X.
 *
 * The app on a fresh database meets the same thing opening a CLI session. Each
 * case below writes the column as the other process would.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "transport-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "transport-ws-"));
});

const invoke = async <T,>(channel: string, ...args: unknown[]): Promise<T> => {
  const { invoke } = await import("../src/cli/agent/ipc");
  return invoke<T>(channel, ...args);
};

/** Two sessions in one folder, as this process sees them; Y has a transport here. */
async function twoSessions() {
  const { AgentSession } = await import("../src/cli/agent/session");
  const s = new AgentSession({ workspaceDir: ws });
  await s.start();
  // Created, not started: starting reuses an empty session, and these must be two.
  const ySession = await invoke<{ id: string }>("sessions:create", s["appId"]);
  const x = await invoke<{ id: string }>("sessions:create", s["appId"]);
  const { chatId } = await invoke<{ chatId: number }>("sessions:allocate-transport", ySession.id);
  return { s, x: x.id, y: { sessionId: ySession.id, chatId } };
}

/** Write X's stream_chat_id as ANOTHER process would: its own transport id, which happens to be Y's here. */
async function otherProcessBinds(sessionId: string, chatId: number) {
  const { db } = await import("../src/db");
  const { chatSessions } = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  await db.update(chatSessions).set({ streamChatId: chatId }).where(eq(chatSessions.id, sessionId));
}

describe("a transport belongs to the session THIS process bound it to", () => {
  it("opening a session never reuses another session's transport (two CLIs, one folder)", async () => {
    const { x, y } = await twoSessions();
    await otherProcessBinds(x, y.chatId);
    const opened = await invoke<{ chatId: number }>("sessions:allocate-transport", x);
    expect(opened.chatId).not.toBe(y.chatId);
    // And what waits for Y (a mid-turn message here) is not X's.
    const { recordUserInterjection, listPendingUserInterjections } = await import("../src/lib/agent/user-interjections");
    recordUserInterjection(y.chatId, { id: "y-1", text: "for Y only" });
    expect(listPendingUserInterjections(opened.chatId)).toEqual([]);
  }, 60_000);

  it("reopening a session this process bound still reuses its transport", async () => {
    const { y } = await twoSessions();
    const again = await invoke<{ chatId: number }>("sessions:allocate-transport", y.sessionId);
    expect(again.chatId).toBe(y.chatId);
  }, 60_000);

  it("a lookup by transport finds this process's session, whatever another process wrote", async () => {
    const { x, y } = await twoSessions();
    // Another process opened Y and stored its own transport id; X now carries this one's.
    await otherProcessBinds(y.sessionId, -999_999);
    await otherProcessBinds(x, y.chatId);
    const { resolveOrBindWorkspaceSessionForStream } = await import("../src/ipc/handlers/workspace_session_handlers");
    expect(await resolveOrBindWorkspaceSessionForStream({ chatId: y.chatId })).toBe(y.sessionId);
    // The revert affordance's read (1c): Y's turns, not X's, and not nothing.
    const { db } = await import("../src/db");
    const { sessionMessages } = await import("../src/db/schema");
    await db.insert(sessionMessages).values({ id: "y-row", sessionId: y.sessionId, role: "assistant", content: "done", snapshotTurnId: "turn-y" });
    const ids = await invoke<Array<{ snapshotTurnId: string }>>("sessions:snapshot-turn-ids", { chatId: y.chatId });
    expect(ids.map((r) => r.snapshotTurnId)).toEqual(["turn-y"]);
  }, 60_000);
});

describe("a CLI numbers its transports below every stored one", () => {
  it("as the app does, so a fresh process does not start at an id already in the column", async () => {
    // A session another process left with a low id.
    const { AgentSession } = await import("../src/cli/agent/session");
    const s = new AgentSession({ workspaceDir: ws });
    await s.start();
    const z = await invoke<{ sessionId: string }>("sessions:start", s["appId"]);
    await otherProcessBinds(z.sessionId, -500);
    const { initializeDatabase, getDb } = await import("../src/db");
    initializeDatabase();
    const client = getDb().$client as unknown as { prepare(sql: string): { all(): Array<{ name: string; file: string }> } };
    const userData = path.dirname(client.prepare("PRAGMA database_list").all().find((d) => d.name === "main")!.file);

    // A fresh CLI process: its first transport.
    const { spawnSync } = await import("node:child_process");
    const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "transport-probe-")), "probe.ts");
    fs.writeFileSync(
      probe,
      `process.env.ATLARIX_USER_DATA_DIR = ${JSON.stringify(userData)};
process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
process.env.ATLARIX_SURFACE = "cli";
const { AgentSession } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/cli/agent/session"))});
const { invoke } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/cli/agent/ipc"))});
const s = new AgentSession({ workspaceDir: ${JSON.stringify(ws)} });
await s.start();
const r = await invoke("sessions:start", s["appId"]);
console.log("CHAT " + r.chatId);
process.exit(0);
`,
    );
    const out = spawnSync(process.execPath, ["run", "--preload", "./tests-bun/preload.ts", probe], {
      cwd: path.join(import.meta.dir, ".."),
      encoding: "utf8",
    });
    const chatId = Number(/CHAT (-?\d+)/.exec(out.stdout)?.[1]);
    expect(chatId).toBeLessThan(-500);
  }, 90_000);
});
