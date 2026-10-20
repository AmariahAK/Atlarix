/**
 * A7 (QA, 4 of 5): a CLI and an editor (ACP) starting together in one folder
 * wrote into ONE session. The editor's new session was still empty, and not yet
 * in the live registry, so the CLI's first message took it as a leftover empty
 * session and reused it (or pruned it under its owner).
 */
import { afterAll, beforeAll, expect, it } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm } from "./fixtures/fake-llm";

let ws: string;
let userData: string;
let child: ChildProcess | null = null;

beforeAll(async () => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "race-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "race-ws-"));
  // The database this process opened (bun runs test files in one process).
  const { initializeDatabase, getDb } = await import("../src/db");
  initializeDatabase();
  const client = getDb().$client as unknown as { prepare(sql: string): { all(): Array<{ name: string; file: string }> } };
  userData = path.dirname(client.prepare("PRAGMA database_list").all().find((d) => d.name === "main")!.file);
});

afterAll(() => {
  child?.stdin?.end();
  child?.kill();
});

it("a CLI starting beside an editor's brand-new session keeps to its own", async () => {
  child = spawn(process.execPath, ["run", "--preload", "./tests-bun/preload.ts", "tests-bun/fixtures/hold-new-session.ts", userData, ws], {
    cwd: path.join(import.meta.dir, ".."),
    stdio: ["pipe", "pipe", "ignore"],
  });
  const editorSession = await new Promise<string>((resolve, reject) => {
    let out = "";
    child!.stdout!.on("data", (d) => {
      out += d.toString();
      const m = /SESSION (\S+)/.exec(out);
      if (m) resolve(m[1]!);
    });
    child!.on("exit", (code) => reject(new Error(`holder exited ${code}`)));
  });

  const llm = startFakeLlm([{ text: "Hello from the CLI's own session." }]);
  const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
  const s = new AgentSession({ workspaceDir: ws, model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model", apiKey: "dev" }) });
  await s.start();
  await s.submit("hi from the CLI");
  for (let i = 0; i < 400 && s.state.busy; i++) await new Promise((r) => setTimeout(r, 50));

  expect(s.sessionId).toBeTruthy();
  expect(s.sessionId).not.toBe(editorSession);
  const { db } = await import("../src/db");
  const { chatSessions, sessionMessages } = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  // The editor's session is still there, and still holds nothing of the CLI's.
  expect(db.select().from(chatSessions).where(eq(chatSessions.id, editorSession)).all()).toHaveLength(1);
  expect(db.select().from(sessionMessages).where(eq(sessionMessages.sessionId, editorSession)).all()).toHaveLength(0);
}, 90_000);
