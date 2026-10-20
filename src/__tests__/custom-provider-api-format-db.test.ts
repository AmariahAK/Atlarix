/**
 * The API format of a provider the user added, through the database: migration
 * 0080 on an existing install, the create/edit handlers, and the provider list
 * every model client is built from.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const handlers = new Map<string, (...a: unknown[]) => unknown>();
vi.mock("electron", () => ({
  app: { isPackaged: false },
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
}));

vi.mock("@/main/settings", () => ({ readSettings: () => ({ providerSettings: {} }) }));

let sqlite: Database.Database;
let dbh: ReturnType<typeof drizzle>;
vi.mock("@/db", () => ({
  get db() {
    return dbh;
  },
}));

const MIGRATION = "0080_custom_provider_api_format";

function statements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

function freshDb() {
  sqlite = new Database(":memory:");
  for (const m of BUNDLED_MIGRATIONS) for (const s of statements(m.sql)) sqlite.exec(s);
  dbh = drizzle(sqlite, { schema });
}

const { registerLanguageModelHandlers } = await import("@/ipc/handlers/language_model_handlers");
const { getLanguageModelProviders } = await import("@/ipc/shared/language_model_helpers");
registerLanguageModelHandlers();
const call = (ch: string, params: unknown) => handlers.get(ch)!({}, params);
const row = (id: string) =>
  sqlite.prepare("SELECT api_format, auth_header FROM language_model_providers WHERE id = ?").get(id) as {
    api_format: string | null;
    auth_header: string | null;
  };

describe("migration 0080 on an existing database", () => {
  it("is bundled (the journal entry is what makes it ship)", () => {
    expect(BUNDLED_MIGRATIONS.map((m) => m.name)).toContain(MIGRATION);
  });

  it("adds the columns and leaves an existing provider OpenAI-compatible", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE IF NOT EXISTS ${ATLARIX_MIGRATIONS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
    for (const m of BUNDLED_MIGRATIONS) {
      if (m.name === MIGRATION) break;
      for (const s of statements(m.sql)) db.exec(s);
      db.prepare(`INSERT INTO ${ATLARIX_MIGRATIONS_TABLE} (name) VALUES (?)`).run(m.name);
    }
    db.prepare("INSERT INTO language_model_providers (id, name, api_base_url) VALUES (?,?,?)").run(
      "custom::old",
      "Old",
      "http://127.0.0.1:1234/v1",
    );
    runPendingAtlarixMigrations(db);
    expect(db.prepare("SELECT api_format, auth_header FROM language_model_providers").get()).toEqual({
      api_format: null,
      auth_header: null,
    });
    db.close();
  });
});

describe("the create and edit handlers", () => {
  beforeEach(freshDb);

  it("store the Anthropic format and key header; the provider list dispatches to the Anthropic SDK", async () => {
    await call("create-custom-language-model-provider", {
      id: "gw",
      name: "Gateway",
      apiBaseUrl: "https://gw.example/anthropic/v1",
      apiFormat: "anthropic",
      authHeader: "bearer",
    });
    expect(row("custom::gw")).toEqual({ api_format: "anthropic", auth_header: "bearer" });
    const p = (await getLanguageModelProviders()).find((x) => x.id === "custom::gw");
    expect(p).toMatchObject({ type: "custom", apiFormat: "anthropic", authHeader: "bearer", npm: "@ai-sdk/anthropic" });
  });

  it("an OpenAI-format provider carries no Anthropic SDK", async () => {
    await call("create-custom-language-model-provider", { id: "plain", name: "Plain", apiBaseUrl: "http://127.0.0.1:1/v1" });
    expect(row("custom::plain")).toEqual({ api_format: null, auth_header: null });
    const p = (await getLanguageModelProviders()).find((x) => x.id === "custom::plain");
    expect(p?.npm).toBeUndefined();
    expect(p?.apiFormat).toBeUndefined();
  });

  it("refuses a duplicate with its own message, not a primary-key error", async () => {
    await call("create-custom-language-model-provider", { id: "dup", name: "Dup", apiBaseUrl: "http://x/v1" });
    await expect(
      call("create-custom-language-model-provider", { id: "dup", name: "Dup", apiBaseUrl: "http://x/v1" }),
    ).rejects.toThrow(/already exists/);
  });

  it("an edit that leaves the format out (the CLI's base-URL change) keeps it", async () => {
    await call("create-custom-language-model-provider", {
      id: "gw",
      name: "Gateway",
      apiBaseUrl: "https://a.example/v1",
      apiFormat: "anthropic",
      authHeader: "bearer",
    });
    await call("edit-custom-language-model-provider", { id: "gw", name: "Gateway", apiBaseUrl: "https://b.example/v1" });
    expect(row("custom::gw")).toEqual({ api_format: "anthropic", auth_header: "bearer" });
  });

  it("switching the format back to OpenAI clears it, and the old key header with it", async () => {
    await call("create-custom-language-model-provider", {
      id: "gw",
      name: "Gateway",
      apiBaseUrl: "https://a.example/v1",
      apiFormat: "anthropic",
      authHeader: "bearer",
    });
    await call("edit-custom-language-model-provider", {
      id: "gw",
      name: "Gateway",
      apiBaseUrl: "https://a.example/v1",
      apiFormat: "openai",
    });
    expect(row("custom::gw")).toEqual({ api_format: null, auth_header: null });
  });

  it("rejects a format it doesn't know", async () => {
    await expect(
      call("create-custom-language-model-provider", { id: "x", name: "X", apiBaseUrl: "http://x/v1", apiFormat: "gemini" }),
    ).rejects.toThrow(/Unknown API format/);
  });
});

describe("the app's key check", () => {
  beforeEach(freshDb);

  it("checks a key before it is saved, so a refused one is never saved (QA R1)", async () => {
    await call("create-custom-language-model-provider", {
      id: "strict",
      name: "Strict",
      apiBaseUrl: "https://gw.example/v1",
      apiFormat: "anthropic",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 })),
    );
    try {
      const check = (await handlers.get("providers:check-key")!({}, "custom::strict", "wrong-key")) as { status: string };
      expect(check).toMatchObject({ status: "rejected" });
      // No candidate and no saved key: nothing to check, and no red rejection (QA #7).
      expect(await handlers.get("providers:check-key")!({}, "custom::strict")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * Sentry ATLARIX-2Z (5 events): `Provider with ID "custom::oai-list" not found`.
 * The provider's own settings page asks for its models again after the delete
 * (the list is invalidated), and main threw for a provider that is gone.
 */
describe("a deleted custom provider", () => {
  beforeEach(freshDb);

  it("has no models, instead of an error", async () => {
    await call("create-custom-language-model-provider", { id: "oai-list", name: "OAI list", apiBaseUrl: "http://127.0.0.1:1/v1" });
    await call("delete-custom-language-model-provider", { providerId: "custom::oai-list" });
    expect(await call("get-language-models", { providerId: "custom::oai-list" })).toEqual([]);
  });
});
