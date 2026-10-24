/**
 * Per-chat model + effort + mode (15.11.1), through the database: migration 0081
 * on an existing install, the one-time fill of today's defaults into existing
 * chats, and the turn reading its chat's row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { BUNDLED_MIGRATIONS } from "@/db/migrations/bundled.generated";
import { ATLARIX_MIGRATIONS_TABLE, runPendingAtlarixMigrations } from "@/db/migrate_atlarix";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), log: vi.fn(), debug: vi.fn() }),
  },
}));

let sqlite: Database.Database;
let dbh: ReturnType<typeof drizzle<typeof schema>>;
vi.mock("@/db", () => ({
  get db() {
    return dbh;
  },
}));
vi.mock("@/lib/chat/stream-transport", () => ({ sessionForTransport: () => undefined }));
const stored = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));
vi.mock("@/main/settings", () => ({ readSettings: () => stored.settings }));

const MIGRATION = "0081_chat_session_model";
const statements = (sql: string) =>
  sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);

function freshDb() {
  sqlite = new Database(":memory:");
  for (const m of BUNDLED_MIGRATIONS) for (const s of statements(m.sql)) sqlite.exec(s);
  dbh = drizzle(sqlite, { schema });
  sqlite.prepare("INSERT INTO apps (id, name, path) VALUES (1, 'w', '/tmp/w')").run();
}
function addSession(id: string, cols: { model?: string | null; work_mode?: string | null } = {}) {
  sqlite
    .prepare("INSERT INTO chat_sessions (id, workspace_id, title, model, work_mode, created_at, updated_at) VALUES (?, 1, 'Untitled', ?, ?, 0, 0)")
    .run(id, cols.model ?? null, cols.work_mode ?? null);
}
const rowOf = (id: string) =>
  sqlite.prepare("SELECT model, work_mode FROM chat_sessions WHERE id = ?").get(id) as {
    model: string | null;
    work_mode: string | null;
  };

const SETTINGS = {
  selectedModel: { provider: "anthropic", name: "claude-haiku-4-5" },
  effort: "high",
  deepThinking: false,
  intentMode: "build",
  workModePreference: "plan",
  selectedChatMode: "ask",
} as never;

describe("migration 0081 on an existing database", () => {
  it("is bundled and adds a NULL model to existing chats", () => {
    expect(BUNDLED_MIGRATIONS.map((m) => m.name)).toContain(MIGRATION);
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE IF NOT EXISTS ${ATLARIX_MIGRATIONS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
    for (const m of BUNDLED_MIGRATIONS) {
      if (m.name === MIGRATION) break;
      for (const s of statements(m.sql)) db.exec(s);
      db.prepare(`INSERT INTO ${ATLARIX_MIGRATIONS_TABLE} (name) VALUES (?)`).run(m.name);
    }
    db.prepare("INSERT INTO apps (id, name, path) VALUES (1, 'w', '/tmp/w')").run();
    db.prepare("INSERT INTO chat_sessions (id, workspace_id, title, created_at, updated_at) VALUES ('old', 1, 'Old', 0, 0)").run();
    runPendingAtlarixMigrations(db);
    expect(db.prepare("SELECT model, title FROM chat_sessions WHERE id='old'").get()).toEqual({
      model: null,
      title: "Old",
    });
  });
});

describe("backfillSessionChoices", () => {
  beforeEach(async () => {
    freshDb();
    (await import("@/main/backfill-session-choices")).__resetLegacyChatWorkModeForTests();
  });

  it("gives every chat without a model today's, once, and touches nothing picked", async () => {
    const { backfillSessionChoices, legacyChatWorkMode } = await import("@/main/backfill-session-choices");
    addSession("blank");
    addSession("picked", { model: JSON.stringify({ provider: "openai", name: "gpt-5" }), work_mode: "debug" });
    addSession("mode-only", { work_mode: "review" });
    const save = vi.fn();

    // What a turn resolves today: a manual intent uses the work-mode preference.
    expect(backfillSessionChoices(dbh, SETTINGS, save)).toEqual({ model: 2, legacyWorkMode: "plan" });
    expect(save).toHaveBeenCalledWith({ legacyChatWorkMode: "plan" });
    expect(JSON.parse(rowOf("blank").model!)).toEqual({
      provider: "anthropic",
      name: "claude-haiku-4-5",
      effort: "high",
      deepThinking: false,
    });
    // Modes stay as stored: a CLI session with none keeps its own on resume.
    // The app reads none as the saved mode instead.
    expect(rowOf("blank").work_mode).toBeNull();
    expect(legacyChatWorkMode(() => ({}))).toBe("plan");
    expect(rowOf("picked")).toEqual({ model: JSON.stringify({ provider: "openai", name: "gpt-5" }), work_mode: "debug" });
    expect(rowOf("mode-only").work_mode).toBe("review");

    // Safe on every start: nothing left to fill, and the saved mode is not moved
    // by a later pick (the app's mode is Build by now).
    save.mockClear();
    const later = { ...(SETTINGS as object), workModePreference: "build", legacyChatWorkMode: "plan" } as never;
    expect(backfillSessionChoices(dbh, later, save)).toEqual({ model: 0, legacyWorkMode: "plan" });
    expect(save).not.toHaveBeenCalled();
  });

  it("is not used by the CLI and the editors", async () => {
    const { legacyChatWorkMode } = await import("@/main/backfill-session-choices");
    const surface = process.env.ATLARIX_SURFACE;
    process.env.ATLARIX_SURFACE = "cli";
    try {
      expect(legacyChatWorkMode(() => ({ legacyChatWorkMode: "plan" }))).toBeNull();
    } finally {
      if (surface === undefined) delete process.env.ATLARIX_SURFACE;
      else process.env.ATLARIX_SURFACE = surface;
    }
  });
});

describe("fillTurnChoicesFromSession", () => {
  beforeEach(async () => {
    freshDb();
    stored.settings = {};
    (await import("@/main/backfill-session-choices")).__resetLegacyChatWorkModeForTests();
  });
  const surface = process.env.ATLARIX_SURFACE;
  afterEach(() => {
    if (surface === undefined) delete process.env.ATLARIX_SURFACE;
    else process.env.ATLARIX_SURFACE = surface;
  });

  it("gives each chat's turn its own model, effort and mode", async () => {
    const { fillTurnChoicesFromSession } = await import("@/main/turn-session-choices");
    addSession("a", { model: JSON.stringify({ provider: "p", name: "model-a", effort: "low" }), work_mode: "ask" });
    addSession("b", { model: JSON.stringify({ provider: "p", name: "model-b", deepThinking: true }), work_mode: "build" });
    const ra = { chatId: -1, prompt: "x", workspaceSessionId: "a" } as never as import("@/ipc/ipc_types").ChatStreamParams;
    const rb = { chatId: -2, prompt: "x", workspaceSessionId: "b" } as never as import("@/ipc/ipc_types").ChatStreamParams;
    await fillTurnChoicesFromSession(ra);
    await fillTurnChoicesFromSession(rb);
    expect([ra.modelOverride, ra.effortOverride, ra.workModeOverride]).toEqual([
      { provider: "p", name: "model-a" },
      { effort: "low", deepThinking: false },
      "ask",
    ]);
    expect([rb.modelOverride, rb.effortOverride, rb.workModeOverride]).toEqual([
      { provider: "p", name: "model-b" },
      { effort: "", deepThinking: true },
      "build",
    ]);
  });

  it("never overrides what the request names, and keeps a slash command's mode", async () => {
    const { fillTurnChoicesFromSession } = await import("@/main/turn-session-choices");
    addSession("a", { model: JSON.stringify({ provider: "p", name: "model-a", effort: "low" }), work_mode: "ask" });
    const req = {
      chatId: -1,
      prompt: "x",
      workspaceSessionId: "a",
      modelOverride: { provider: "p", name: "stronger" },
      streamChatModeOverride: "build",
    } as never as import("@/ipc/ipc_types").ChatStreamParams;
    await fillTurnChoicesFromSession(req);
    expect(req.modelOverride).toEqual({ provider: "p", name: "stronger" });
    // Another model than the chat's: its effort is not carried over.
    expect(req.effortOverride).toBeUndefined();
    expect(req.workModeOverride).toBeUndefined();
  });

  it("leaves CLI and editor turns alone (their session state is in memory)", async () => {
    const { fillTurnChoicesFromSession } = await import("@/main/turn-session-choices");
    addSession("a", { model: JSON.stringify({ provider: "p", name: "model-a", effort: "low" }), work_mode: "ask" });
    process.env.ATLARIX_SURFACE = "cli";
    const req = { chatId: -1, prompt: "x", workspaceSessionId: "a" } as never as import("@/ipc/ipc_types").ChatStreamParams;
    await fillTurnChoicesFromSession(req);
    expect(req.modelOverride).toBeUndefined();
    expect(req.effortOverride).toBeUndefined();
    expect(req.workModeOverride).toBeUndefined();
  });

  it("a chat with nothing stored: the app's model, and the mode saved at the upgrade", async () => {
    const { fillTurnChoicesFromSession } = await import("@/main/turn-session-choices");
    addSession("blank");
    stored.settings = { legacyChatWorkMode: "plan", workModePreference: "build" };
    const req = { chatId: -1, prompt: "x", workspaceSessionId: "blank" } as never as import("@/ipc/ipc_types").ChatStreamParams;
    await fillTurnChoicesFromSession(req);
    expect(req.modelOverride).toBeUndefined();
    expect(req.workModeOverride).toBe("plan");
  });
});
