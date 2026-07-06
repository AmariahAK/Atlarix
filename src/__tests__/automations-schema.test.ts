import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyEmbeddedSqlMigrations } from "@/db/migrate_atlarix";

function tableColumns(db: Database.Database, table: string): Map<string, { dflt: unknown; notnull: number }> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    dflt_value: unknown;
    notnull: number;
  }>;
  return new Map(rows.map((r) => [r.name, { dflt: r.dflt_value, notnull: r.notnull }]));
}

describe("0066_automations migration", () => {
  it("creates both tables with expected columns/defaults, idempotently", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");

    applyEmbeddedSqlMigrations(db);

    const auto = tableColumns(db, "automations");
    expect([...auto.keys()]).toEqual(
      expect.arrayContaining([
        "id", "workspace_id", "name", "enabled", "trigger", "prompt",
        "run_mode", "model", "cursor", "last_run_at", "created_at", "updated_at",
      ]),
    );
    expect(auto.get("run_mode")?.dflt).toBe("'read-only'");
    expect(auto.get("enabled")?.notnull).toBe(1);
    expect(auto.get("workspace_id")?.notnull).toBe(0); // nullable for future global automations

    const runs = tableColumns(db, "automation_runs");
    expect([...runs.keys()]).toEqual(
      expect.arrayContaining([
        "id", "automation_id", "session_id", "status", "summary", "error",
        "unread", "archived", "proposal_diff", "proposal_files",
        "proposal_applied_at", "started_at", "finished_at",
      ]),
    );

    // Ledger idempotency: a second apply is a clean no-op.
    expect(() => applyEmbeddedSqlMigrations(db)).not.toThrow();

    // FK behavior: run rows cascade with their automation.
    db.prepare(
      "INSERT INTO apps (name, path) VALUES ('a', '/tmp/a')",
    ).run();
    const appId = (db.prepare("SELECT id FROM apps LIMIT 1").get() as { id: number }).id;
    db.prepare(
      "INSERT INTO automations (id, workspace_id, name, trigger, prompt) VALUES ('au1', ?, 'n', '{}', 'p')",
    ).run(appId);
    db.prepare(
      "INSERT INTO automation_runs (id, automation_id, status) VALUES ('r1', 'au1', 'ok')",
    ).run();
    db.prepare("DELETE FROM automations WHERE id = 'au1'").run();
    expect(db.prepare("SELECT COUNT(*) c FROM automation_runs").get()).toMatchObject({ c: 0 });

    db.close();
  });
});
