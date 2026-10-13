import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron-log", () => ({ default: { scope: () => ({ info() {}, warn() {}, error() {}, debug() {} }) } }));
vi.mock("@/db", () => ({ getDb: () => ({ $client: null }) }));
vi.mock("@/lib/chat/stream-transport", () => ({ getStreamTransportAppId: (chatId: number) => (chatId === -1 ? 7 : chatId === -2 ? 8 : null) }));

import { __setDeliveryDatabaseForTests, claimFinishedRuns, markRunDelivered } from "@/lib/automations/agent-delivery";
import { clearAutomationResultsForTests, describePendingAutomationResults, takePendingAutomationResults } from "@/lib/agent/automation-results";

const now = Date.UTC(2026, 9, 13, 21, 0, 0);
let db: DatabaseSync;

function run(id: string, automation: string, status: string, finishedAgoMs: number, summary = "3 failing tests in src/math.test.ts") {
  db.prepare("INSERT INTO automation_runs (id, automation_id, status, summary, error, finished_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id, automation, status, status === "error" ? null : summary, status === "error" ? "npm test exited 1" : null, Math.floor((now - finishedAgoMs) / 1000),
  );
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE automations (id TEXT PRIMARY KEY, workspace_id INTEGER, name TEXT, notify_agent INTEGER);
           CREATE TABLE automation_runs (id TEXT PRIMARY KEY, automation_id TEXT, status TEXT, summary TEXT, error TEXT, finished_at INTEGER);`);
  db.exec(`INSERT INTO automations VALUES ('a-tests', 7, 'Weekday tests', 1), ('a-quiet', 7, 'Slack inbox', 0), ('a-other', 8, 'Other folder', 1);`);
  __setDeliveryDatabaseForTests(() => db as never);
  clearAutomationResultsForTests();
});

describe("a finished automation reaches one chat's agent, from any Atlarix (owner)", () => {
  it("one claimer wins a run; the other process gets nothing", async () => {
    run("r1", "a-tests", "ok", 30_000);
    const app = await claimFinishedRuns([7], "app:1", now);
    const cli = await claimFinishedRuns([7], "cli:2", now);
    expect(app).toEqual([{ workspaceId: 7, wake: true }]);
    expect(cli).toEqual([]);
    expect(describePendingAutomationResults(-1)).toEqual(['Automation "Weekday tests" finished: 3 failing tests in src/math.test.ts']);
    expect(takePendingAutomationResults(-1)).toContain("Weekday tests");
  });

  it("only notify-the-agent runs that finished with something, in the folders asked for", async () => {
    run("r1", "a-quiet", "ok", 1_000); // notify_agent off
    run("r2", "a-tests", "nothing-to-report", 1_000);
    run("r3", "a-other", "error", 1_000); // another folder
    expect(await claimFinishedRuns([7], "app:1", now)).toEqual([]);
    expect(await claimFinishedRuns([8], "app:1", now)).toEqual([{ workspaceId: 8, wake: true }]);
    expect(describePendingAutomationResults(-2)[0]).toContain('"Other folder" failed: npm test exited 1');
  });

  it("an old result goes into the next message without waking anyone", async () => {
    run("r1", "a-tests", "ok", 60 * 60_000);
    expect(await claimFinishedRuns([7], "cli:2", now)).toEqual([{ workspaceId: 7, wake: false }]);
  });

  it("a run the agent asked for is not delivered a second time", async () => {
    run("r1", "a-tests", "ok", 5_000);
    markRunDelivered("r1", "app:1");
    expect(await claimFinishedRuns([7], "cli:2", now)).toEqual([]);
  });
});
