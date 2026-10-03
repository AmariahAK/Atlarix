/**
 * Automations run in whichever Atlarix is open — the desktop app, the CLI, or
 * both on one database (runner.ts, drizzle 0077). Against a real temp SQLite:
 *
 *  - each occurrence is claimed once: a second claim for the same slot loses,
 *    whichever process makes it;
 *  - startup recovery fails only runs whose process is gone (no owner, or a
 *    stale heartbeat), never another process's live run;
 *  - the heartbeat keeps this process's running runs fresh.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, initializeDatabase } from "@/db/index";
import { apps, automationLeases, automationRuns, automations } from "@/db/schema";
import {
  STALE_HEARTBEAT_MS,
  beatForTests,
  claimSlot,
  pollSlot,
  recoverInterruptedRuns,
  scheduleSlot,
} from "@/lib/automations/runner";
import { PROCESS_OWNER } from "@/lib/automations/process-owner";

const SLOW_DB_TIMEOUT_MS = 60_000;
let tempDir: string;
let automationId: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-leases-"));
  process.env.ATLARIX_USER_DATA_DIR = tempDir;
  initializeDatabase();
  const [app] = db.insert(apps).values({ name: "ws", path: tempDir }).returning().all();
  automationId = randomUUID();
  db.insert(automations)
    .values({
      id: automationId,
      workspaceId: app!.id,
      name: "Nightly",
      enabled: true,
      trigger: JSON.stringify({ kind: "schedule", cron: "0 9 * * *" }),
      prompt: "",
      runMode: "notify-only",
      notifyAgent: false,
    })
    .run();
}, SLOW_DB_TIMEOUT_MS);

afterAll(() => {
  delete process.env.ATLARIX_USER_DATA_DIR;
  try {
    db.$client.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function insertRun(over: Partial<typeof automationRuns.$inferInsert>): string {
  const id = randomUUID();
  db.insert(automationRuns)
    .values({ id, automationId, sessionId: null, status: "running", startedAt: new Date(), ...over })
    .run();
  return id;
}

const statusOf = (id: string) =>
  db.select().from(automationRuns).where(eq(automationRuns.id, id)).all()[0]!.status;

describe("automation leases", () => {
  it("an occurrence is claimed once", async () => {
    const slot = scheduleSlot(new Date("2026-10-02T09:00:12Z"));
    expect(slot).toBe("schedule:2026-10-02T09:00");
    expect(await claimSlot(automationId, slot)).toBe(true);
    expect(await claimSlot(automationId, slot)).toBe(false);
    // The next occurrence is a new slot.
    expect(await claimSlot(automationId, scheduleSlot(new Date("2026-10-03T09:00:00Z")))).toBe(true);
  });

  it("a slot another process took is lost here", async () => {
    const slot = scheduleSlot(new Date("2026-10-04T09:00:00Z"));
    db.insert(automationLeases).values({ automationId, slotKey: slot, owner: "desktop:123:abcd" }).run();
    expect(await claimSlot(automationId, slot)).toBe(false);
  });

  it("poll slots bucket by the interval", () => {
    const t = Date.UTC(2026, 9, 2, 9, 7);
    expect(pollSlot(15, t)).toBe(pollSlot(15, t + 7 * 60_000));
    expect(pollSlot(15, t)).not.toBe(pollSlot(15, t + 8 * 60_000 + 60_000));
  });

  it("startup recovery fails only runs whose process is gone", async () => {
    const legacy = insertRun({ owner: null, heartbeatAt: null });
    const dead = insertRun({ owner: "cli:999:dead", heartbeatAt: new Date(Date.now() - STALE_HEARTBEAT_MS - 60_000) });
    const liveElsewhere = insertRun({ owner: "desktop:123:live", heartbeatAt: new Date() });
    await recoverInterruptedRuns();
    expect(statusOf(legacy)).toBe("error");
    expect(statusOf(dead)).toBe("error");
    expect(statusOf(liveElsewhere)).toBe("running");
  });

  it("the heartbeat keeps this process's running runs fresh", async () => {
    const mine = insertRun({ owner: PROCESS_OWNER, heartbeatAt: new Date(Date.now() - 10 * 60_000) });
    await beatForTests();
    const beat = db.select().from(automationRuns).where(eq(automationRuns.id, mine)).all()[0]!.heartbeatAt!;
    expect(Date.now() - beat.getTime()).toBeLessThan(5_000);
    await recoverInterruptedRuns();
    expect(statusOf(mine)).toBe("running");
  });
});
