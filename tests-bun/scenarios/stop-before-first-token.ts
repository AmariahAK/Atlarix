/**
 * A stop before a turn's first token (QA 15.7.1 #2). Prints one `RESULT {json}`
 * line for cli-session.test.ts: the stored rows of the chat, so the stopped
 * turn's record (just the stop note) can be checked, not only the screen.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeLlm } from "../fixtures/fake-llm";

process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "stop0-ud-"),
);
process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "stop0-ws-"));

const { installProcessGuards } = await import("../../src/cli/shutdown");
installProcessGuards();
const llm = startFakeLlm([
  { text: "10" },
  { text: "Volcanoes are openings in the crust.", waitMs: 20_000 },
]);
const { AgentSession, seedDevProvider } = await import(
  "../../src/cli/agent/session"
);
const s = new AgentSession({
  workspaceDir: ws,
  model: await seedDevProvider({ baseUrl: llm.url, model: "fake-model" }),
});
await s.start();
const idle = async (ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && s.state.busy) await Bun.sleep(100);
};
await s.submit("What is 5+5?");
await idle();
await s.submit("Write an essay about volcanoes.");
await Bun.sleep(1000);
await s.interrupt();
await idle(10_000);
await Bun.sleep(800);
const { db } = await import("../../src/db");
const { sessionMessages } = await import("../../src/db/schema");
const { eq, asc } = await import("drizzle-orm");
const sid = (s as unknown as { sessionId: string }).sessionId;
const rows = await db
  .select()
  .from(sessionMessages)
  .where(eq(sessionMessages.sessionId, sid))
  .orderBy(asc(sessionMessages.createdAt));
console.log(
  "RESULT " +
    JSON.stringify(
      rows.map((r: { role: string; status: string; content: string }) => [
        r.role,
        r.status,
        r.content.slice(0, 80),
      ]),
    ),
);
llm.stop();
process.exit(0);
