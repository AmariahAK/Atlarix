/**
 * Live sessions across surfaces and /fork (PLAN-live-sessions-and-fork.md),
 * through the real handlers and database, as the CLI and ACP drive them.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm } from "./fixtures/fake-llm";

let ws: string;
beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "live-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "live-ws-"));
  fs.writeFileSync(path.join(ws, "a.ts"), "export const a = 1;\n");
});

const idle = async (s: { state: { busy: boolean }; sessionId: string }) => {
  for (let i = 0; i < 300 && (s.state.busy || !s.sessionId); i++) await new Promise((r) => setTimeout(r, 100));
};

async function sessionWithTwoTurns() {
  const llm = startFakeLlm([
    { tool: "read_file", args: { path: "a.ts" } },
    { text: "It exports a." },
    { text: "Done." },
  ]);
  const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
  const s = new AgentSession({ workspaceDir: ws, model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" }) });
  await s.start();
  await s.submit("what does a.ts export?");
  await idle(s);
  await s.submit("thanks");
  await idle(s);
  return s;
}

const invoke = async <T,>(channel: string, ...args: unknown[]): Promise<T> => {
  const { invoke } = await import("../src/cli/agent/ipc");
  return invoke<T>(channel, ...args);
};

async function rowsOf(sessionId: string) {
  const { db } = await import("../src/db");
  const { sessionMessages } = await import("../src/db/schema");
  const { asc, eq, sql } = await import("drizzle-orm");
  return db
    .select()
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(asc(sessionMessages.createdAt), sql`rowid asc`);
}

describe("sessions:revision", () => {
  it("moves when the session's messages do, and only then", async () => {
    const s = await sessionWithTwoTurns();
    const a = await invoke<string>("sessions:revision", s.sessionId);
    expect(await invoke<string>("sessions:revision", s.sessionId)).toBe(a);
    // A draft growing: the same row, more text.
    const { db } = await import("../src/db");
    const { sessionMessages } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    const last = (await rowsOf(s.sessionId)).at(-1)!;
    await db.update(sessionMessages).set({ content: `${last.content} and more` }).where(eq(sessionMessages.id, last.id));
    expect(await invoke<string>("sessions:revision", s.sessionId)).not.toBe(a);
  }, 60_000);
});

describe("sessions:fork", () => {
  it("copies the conversation in order, tool history and all, as '<title> (fork)'", async () => {
    const s = await sessionWithTwoTurns();
    const source = await rowsOf(s.sessionId);
    expect(source.some((r) => r.modelContent)).toBe(true); // the read_file turn's native history

    const fork = await invoke<{ id: string; title: string; titleSource: string; workspaceId: number }>("sessions:fork", s.sessionId);
    expect(fork.id).not.toBe(s.sessionId);
    expect(fork.title).toMatch(/ \(fork\)$/);
    expect(fork.titleSource).toBe("auto");

    const copied = await rowsOf(fork.id);
    const strip = (r: (typeof source)[number]) => ({ ...r, id: undefined, sessionId: undefined });
    expect(copied.map(strip)).toEqual(source.map(strip));
    // The original is untouched.
    expect((await rowsOf(s.sessionId)).map((r) => r.id)).toEqual(source.map((r) => r.id));
  }, 60_000);

  it("takes the name it is given", async () => {
    const s = await sessionWithTwoTurns();
    const fork = await invoke<{ title: string; titleSource: string }>("sessions:fork", s.sessionId, { title: "try the other way" });
    expect(fork).toMatchObject({ title: "try the other way", titleSource: "user" });
  }, 60_000);

  it("leaves out a turn still being written", async () => {
    const s = await sessionWithTwoTurns();
    const { db } = await import("../src/db");
    const { sessionMessages } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await rowsOf(s.sessionId);
    const draft = rows.at(-1)!;
    await db.update(sessionMessages).set({ status: "interrupted" }).where(eq(sessionMessages.id, draft.id));
    const { activeStreams } = await import("../src/ipc/handlers/chat_stream/stream-state");
    const { chatSessions } = await import("../src/db/schema");
    const session = await db.query.chatSessions.findFirst({ where: eq(chatSessions.id, s.sessionId) });
    activeStreams.set(session!.streamChatId!, new AbortController()); // its turn is running
    try {
      const fork = await invoke<{ id: string }>("sessions:fork", s.sessionId);
      expect((await rowsOf(fork.id)).length).toBe(rows.length - 1);
    } finally {
      activeStreams.delete(session!.streamChatId!);
    }
    // Not running: an interrupted last turn is a finished one, and comes along.
    const fork = await invoke<{ id: string }>("sessions:fork", s.sessionId);
    expect((await rowsOf(fork.id)).length).toBe(rows.length);
  }, 60_000);
});

/**
 * Two processes on one session, as the CLI and an editor (or the app) are.
 * Process A (fixtures/live-runner.ts) runs the turns; this process resumes the
 * same session and follows them.
 */
describe("a session followed from another process", () => {
  it("shows A's turn as it runs, steers it, stops it, then runs the next turn itself", async () => {
    const llm = startFakeLlm([
      { tool: "run_command", args: { command: "sleep 4", description: "wait a bit" } }, // A, turn 1
      { text: "Heard you." }, // A, turn 1: its request carries the steer
      { tool: "run_command", args: { command: "sleep 60", description: "wait long" } }, // A, turn 2: stopped from here
      { text: "Running here now." }, // this process's own turn
    ]);
    // The database THIS process has open: bun runs test files in one process, and
    // the first one to open the database decides where it is.
    const { initializeDatabase, getDb } = await import("../src/db");
    initializeDatabase();
    const client = getDb().$client as unknown as { prepare(sql: string): { all(): Array<{ name: string; file: string }> } };
    const userData = path.dirname(client.prepare("PRAGMA database_list").all().find((d) => d.name === "main")!.file);
    const { spawn } = await import("node:child_process");
    const a = spawn(
      process.execPath,
      ["run", "--preload", "./tests-bun/preload.ts", "tests-bun/fixtures/live-runner.ts", userData, ws, llm.url],
      { cwd: path.join(import.meta.dir, ".."), stdio: ["pipe", "pipe", "inherit"] },
    );
    const lines: string[] = [];
    a.stdout!.on("data", (c: Buffer) => lines.push(...c.toString().split("\n").filter(Boolean)));
    const until = async (pred: () => boolean | Promise<boolean>, ms = 30_000) => {
      for (const t0 = Date.now(); !(await pred()); await new Promise((r) => setTimeout(r, 100))) {
        if (Date.now() - t0 > ms) throw new Error(`timed out; A said: ${lines.join(" | ")}`);
      }
    };
    /** One follow poll, then the condition. */
    const following = (b: { checkFollowing(): Promise<void> }, pred: () => boolean) => async () => {
      await b.checkFollowing();
      return pred();
    };
    const idles = () => lines.filter((l) => l === "IDLE").length;
    try {
      a.stdin!.write("submit run the slow thing\n");
      await until(() => lines.some((l) => l.startsWith("SESSION ")));
      const sessionId = lines.find((l) => l.startsWith("SESSION "))!.slice(8);

      const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
      const b = new AgentSession({ workspaceDir: ws, model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" }) });
      await b.start();
      await b.resume(sessionId);

      // Following: A's turn is on screen here while it runs.
      await until(following(b, () => b.state.following != null));
      expect(b.state.following).toMatchObject({ surface: "cli" });
      await until(following(b, () => b.state.cells.some((c) => c.kind === "tool")));

      // What you type here goes to A's turn, as your own message there.
      await b.submit("also check the empty file case");
      await until(() => idles() >= 1);
      const heard = llm.requests.filter((r) => r.tools?.length)[1]!;
      expect(JSON.stringify(heard.messages)).toContain("also check the empty file case");

      // A idle: this process stops following.
      await until(following(b, () => b.state.following == null));

      // A runs a long turn; stop it from here.
      a.stdin!.write("submit now the long one\n");
      await until(following(b, () => b.state.following != null));
      await b.interrupt();
      await until(() => idles() >= 2, 20_000);

      // A stopped turn reads as ended at once, not at the next 15 s heartbeat:
      // a follower went on showing "Running in the CLI" 5–11 s after Stop.
      await until(following(b, () => b.state.following == null), 3_000);

      // Then this process runs the next turn itself, with the whole conversation.
      await b.submit("my turn");
      await idle(b);
      const mine = llm.requests.filter((r) => r.tools?.length).at(-1)!;
      expect(JSON.stringify(mine.messages)).toContain("run the slow thing");
      expect(JSON.stringify(mine.messages)).toContain("also check the empty file case");
      expect(b.state.cells.some((c) => c.kind === "markdown" && c.text === "Running here now.")).toBe(true);
      await b.close();
    } finally {
      a.stdin!.end();
      a.kill();
    }
  }, 120_000);
});
