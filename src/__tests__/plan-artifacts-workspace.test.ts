/**
 * A plan outlives its session: the CLI's /plan and the app's Plan panel list
 * plans from the folder's OTHER sessions, and "use in this session" copies one
 * in to build (src/lib/plans/plan-artifacts.ts). Against a real temp SQLite.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, initializeDatabase } from "@/db/index";
import { apps, chatSessions } from "@/db/schema";
import {
  copyPlanArtifactToSession,
  createPlanArtifact,
  listPlanArtifactsForSession,
  listPlanArtifactsForWorkspace,
  setPlanArtifactStatus,
} from "@/lib/plans/plan-artifacts";

let dir: string;
let ws: number;
let other: number;
const session = (workspaceId: number, title: string) => {
  const id = randomUUID();
  db.insert(chatSessions).values({ id, workspaceId, title }).run();
  return id;
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlarix-plans-ws-"));
  process.env.ATLARIX_USER_DATA_DIR = dir;
  initializeDatabase();
  ws = db.insert(apps).values({ name: "a", path: path.join(dir, "a") }).returning().all()[0]!.id;
  other = db.insert(apps).values({ name: "b", path: path.join(dir, "b") }).returning().all()[0]!.id;
}, 60_000);

afterAll(() => {
  delete process.env.ATLARIX_USER_DATA_DIR;
  try {
    db.$client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("plans across sessions", () => {
  it("lists the folder's plans from other sessions, with the session's title", async () => {
    const earlier = session(ws, "Billing work");
    const current = session(ws, "Today");
    const elsewhere = session(other, "Another folder");
    await createPlanArtifact(earlier, "# Add billing\n- [ ] Stripe", "Add billing");
    await createPlanArtifact(current, "# Today's plan", "Today's plan");
    await createPlanArtifact(elsewhere, "# Not this folder", "Not this folder");

    const rows = await listPlanArtifactsForWorkspace(ws, { excludeSessionId: current });
    expect(rows.map((r) => [r.title, r.sessionTitle])).toEqual([["Add billing", "Billing work"]]);
  });

  it("copies a plan into another session to build it there; the original keeps its status", async () => {
    const earlier = session(ws, "Old");
    const current = session(ws, "New");
    const original = await createPlanArtifact(earlier, "# Ship it\n- [x] done", "Ship it");
    await setPlanArtifactStatus(original.id, "built");

    const copy = await copyPlanArtifactToSession(original.id, current);
    expect(copy).toMatchObject({ sessionId: current, title: "Ship it", planStatus: "plan", content: "# Ship it\n- [x] done" });
    expect(copy!.id).not.toBe(original.id);
    expect((await listPlanArtifactsForSession(earlier))[0]!.planStatus).toBe("built");
  });
});
