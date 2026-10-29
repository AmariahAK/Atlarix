/**
 * Usage: what a turn records, and what the Usage page reads back — on a real
 * database with every migration applied.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { BUNDLED_MIGRATIONS } from "@/db/migrations/bundled.generated";

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

let sqlite: Database.Database;
let dbh: ReturnType<typeof drizzle>;
vi.mock("@/db", () => ({
  get db() {
    return dbh;
  },
}));

const U = await import("@/lib/stats/usage-stats");

function freshDb() {
  sqlite = new Database(":memory:");
  for (const m of BUNDLED_MIGRATIONS) {
    for (const stmt of m.sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean))
      sqlite.exec(stmt);
  }
  dbh = drizzle(sqlite, { schema });
  sqlite
    .prepare(
      "INSERT INTO apps (id, name, path) VALUES (1, 'demo', '/tmp/demo')",
    )
    .run();
}

/** A chat with user messages at these local times (history from before the rollup). */
function chat(id: string, title: string, times: Date[]) {
  sqlite
    .prepare(
      "INSERT INTO chat_sessions (id, workspace_id, title, title_source, created_at, updated_at) VALUES (?, 1, ?, 'user', 0, 0)",
    )
    .run(id, title);
  times.forEach((t, i) => {
    sqlite
      .prepare(
        "INSERT INTO session_messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', 'hi', ?)",
      )
      .run(`${id}-${i}`, id, Math.floor(t.getTime() / 1000));
  });
}

const at = (y: number, m: number, d: number, h = 12) =>
  new Date(y, m - 1, d, h);
const TODAY = at(2026, 10, 15, 20);

beforeEach(() => freshDb());

describe("recording a turn", () => {
  it("adds to the day's bucket for that surface, model and mode", async () => {
    const turn = {
      model: { provider: "compass", name: "openai/gpt-5.4-mini" },
      mode: "build",
      deep: false,
      inputTokens: 1000,
      outputTokens: 200,
      messages: [],
      surface: "cli" as const,
      now: TODAY,
    };
    await U.recordTurnUsage(turn);
    await U.recordTurnUsage({
      ...turn,
      deep: true,
      inputTokens: 500,
      outputTokens: 50,
    });
    const rows = sqlite.prepare("SELECT * FROM usage_rollup").all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: "2026-10-15",
      surface: "cli",
      editor: "",
      source: "chat",
      turns: 2,
      deep_turns: 1,
      input_tokens: 1500,
      output_tokens: 250,
    });
    // Nothing new goes to the table older builds still write.
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM usage_stats").get()).toEqual({ n: 0 });
  });

  it("adds a stopped turn's tokens but does not count it as a turn", async () => {
    const base = {
      model: { provider: "anthropic", name: "claude-sonnet-5-5" },
      mode: "build",
      deep: true,
      messages: [],
      surface: "app" as const,
      now: TODAY,
    };
    await U.recordTurnUsage({ ...base, inputTokens: 800, outputTokens: 20, finished: false });
    // Stopped before anything was spent: no row at all.
    await U.recordTurnUsage({ ...base, inputTokens: 0, outputTokens: 0, finished: false });
    const rows = sqlite.prepare("SELECT turns, deep_turns, input_tokens, output_tokens FROM usage_rollup").all();
    expect(rows).toEqual([{ turns: 0, deep_turns: 0, input_tokens: 800, output_tokens: 20 }]);
  });

  it("puts sub-agent and compaction tokens on their own rows, and automations apart", async () => {
    await U.recordTurnUsage({
      model: { provider: "openai", name: "gpt-5.4" },
      mode: "build",
      deep: false,
      automation: true,
      inputTokens: 100,
      outputTokens: 10,
      aux: U.auxSpendFrom({
        "subagent:task": { tokens: 70, inputTokens: 60, outputTokens: 10 },
        "subagent:explore": { tokens: 30, inputTokens: 25, outputTokens: 5 },
        compaction: { tokens: 40, inputTokens: 0, outputTokens: 0 },
        title: { tokens: 0, inputTokens: 0, outputTokens: 0 },
      }),
      messages: [],
      surface: "cli",
      now: TODAY,
    });
    const rows = sqlite
      .prepare("SELECT source, turns, input_tokens, output_tokens FROM usage_rollup ORDER BY source")
      .all();
    expect(rows).toEqual([
      { source: "automation", turns: 1, input_tokens: 100, output_tokens: 10 },
      // A provider that reported only a total counts it as input, not nothing.
      { source: "compaction", turns: 0, input_tokens: 40, output_tokens: 0 },
      { source: "subagent", turns: 0, input_tokens: 85, output_tokens: 15 },
    ]);
  });

  it("keeps the cache split and a BYOK estimate, and counts the turns with no price", async () => {
    const base = {
      model: { provider: "anthropic", name: "claude-sonnet-5-5" },
      mode: "build",
      deep: false,
      inputTokens: 10_000,
      outputTokens: 500,
      messages: [],
      surface: "app" as const,
      now: TODAY,
    };
    await U.recordTurnUsage({ ...base, cacheReadTokens: 8000, cacheWriteTokens: 1000, costUsd: 0.012345 });
    await U.recordTurnUsage({ ...base, costUsd: null });
    // Atlarix turns carry no estimate (undefined): neither priced nor unpriced.
    await U.recordTurnUsage({ ...base, model: { provider: "compass", name: "atlarix/auto" } });
    const rows = sqlite
      .prepare(
        "SELECT provider, cache_read_tokens, cache_write_tokens, est_cost_micros, priced_turns, unpriced_turns FROM usage_rollup ORDER BY provider",
      )
      .all();
    expect(rows).toEqual([
      { provider: "anthropic", cache_read_tokens: 8000, cache_write_tokens: 1000, est_cost_micros: 12345, priced_turns: 1, unpriced_turns: 1 },
      { provider: "compass", cache_read_tokens: 0, cache_write_tokens: 0, est_cost_micros: 0, priced_turns: 0, unpriced_turns: 0 },
    ]);
  });

  it("groups editors by the name the editor gave", async () => {
    const prev = process.env.ATLARIX_ACP_EDITOR;
    process.env.ATLARIX_ACP_EDITOR = " Zed ";
    try {
      await U.recordTurnUsage({
        model: null,
        mode: "build",
        deep: false,
        inputTokens: 1,
        outputTokens: 1,
        messages: [],
        surface: "editor",
        now: TODAY,
      });
    } finally {
      if (prev === undefined) delete process.env.ATLARIX_ACP_EDITOR;
      else process.env.ATLARIX_ACP_EDITOR = prev;
    }
    expect(sqlite.prepare("SELECT surface, editor FROM usage_rollup").get()).toEqual({ surface: "editor", editor: "zed" });
  });

  it("records which model each Atlarix Auto reply came from", async () => {
    await U.recordAutoPick({ servedModel: "gpt-5.4-mini", billing: "free", tier: "auto", surface: "app", now: TODAY });
    await U.recordAutoPick({ servedModel: "gpt-5.4-mini", billing: "free", tier: "auto", surface: "app", now: TODAY });
    await U.recordAutoPick({ servedModel: "claude-opus-5-5", billing: "paid", tier: "Zenith", surface: "app", now: TODAY });
    // A reply that names no model, or no payer, adds nothing.
    await U.recordAutoPick({ servedModel: null, billing: "free", surface: "app", now: TODAY });
    await U.recordAutoPick({ servedModel: "x", billing: null, surface: "app", now: TODAY });
    const rows = sqlite.prepare("SELECT billing, tier, served_model, steps FROM usage_auto_picks ORDER BY served_model").all();
    expect(rows).toEqual([
      { billing: "paid", tier: "zenith", served_model: "claude-opus-5-5", steps: 1 },
      { billing: "free", tier: "auto", served_model: "gpt-5.4-mini", steps: 2 },
    ]);
  });

  it("counts skills read and MCP servers called", async () => {
    await U.recordTurnUsage({
      model: null,
      mode: "build",
      deep: false,
      inputTokens: 0,
      outputTokens: 0,
      now: TODAY,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "read_file",
              input: { path: ".atlarix/skills/release.md" },
            },
            {
              type: "tool-call",
              toolName: "read_file",
              input: {
                path: "C:\\work\\app\\.atlarix\\skills\\review\\pr-review.md",
              },
            },
            {
              type: "tool-call",
              toolName: "read_file",
              input: { path: "src/index.ts" },
            },
            {
              type: "tool-call",
              toolName: "mcp_call",
              input: { server: "deepwiki", tool: "ask" },
            },
            {
              type: "tool-call",
              toolName: "mcp_call",
              args: { server: "deepwiki", tool: "read" },
            },
          ],
        },
      ],
    });
    const rows = sqlite
      .prepare(
        "SELECT kind, name, runs FROM usage_tool_stats ORDER BY kind, name",
      )
      .all();
    expect(rows).toEqual([
      { kind: "mcp", name: "deepwiki", runs: 2 },
      { kind: "skill", name: "pr-review", runs: 1 },
      { kind: "skill", name: "release", runs: 1 },
    ]);
  });
});

describe("the stats page", () => {
  it("reads history and recorded turns into one picture", async () => {
    // History before this release: three days in a row, then today.
    chat("a", "Fix the login bug", [
      at(2026, 10, 10, 9),
      at(2026, 10, 10, 11),
      at(2026, 10, 11),
      at(2026, 10, 12),
    ]);
    chat("b", "Quick question", [at(2026, 9, 1)]);
    // Three messages ten minutes apart: half an hour of work, however it started.
    chat("c", "Short and busy", [
      new Date(2026, 9, 12, 14, 0),
      new Date(2026, 9, 12, 14, 10),
      new Date(2026, 9, 12, 14, 20),
      new Date(2026, 9, 12, 14, 30),
    ]);
    const base = {
      mode: "build",
      deep: false,
      messages: [],
      surface: "app" as const,
      now: TODAY,
    };
    await U.recordTurnUsage({
      ...base,
      model: { provider: "compass", name: "openai/gpt-5.4-mini" },
      inputTokens: 9000,
      outputTokens: 1000,
    });
    await U.recordTurnUsage({
      ...base,
      model: { provider: "deepseek", name: "deepseek-chat" },
      mode: "plan",
      deep: true,
      inputTokens: 4000,
      outputTokens: 1000,
      surface: "cli",
    });

    const s = await U.getActivityStats(TODAY);
    expect(s.since).toBe("2026-09-01");
    expect(s.recordedSince).toBe("2026-10-15");
    expect(s.lifetimeTokens).toBe(15000);
    expect(s.peakDay).toEqual({ day: "2026-10-15", tokens: 15000 });
    expect(s.currentStreak).toBe(1);
    expect(s.longestStreak).toBe(3);
    expect(s.totalChats).toBe(3);
    expect(s.totalTurns).toBe(5 + 4 + 2);
    // Active time: "Fix the login bug" spans three days but its gaps are all breaks.
    expect(s.longestChat).toEqual({ title: "Short and busy", minutes: 30 });
    expect(s.models.map((m) => [m.modelId, m.share])).toEqual([
      // A tie reads in model order.
      ["deepseek-chat", 50],
      ["openai/gpt-5.4-mini", 50],
    ]);
    expect(s.modes).toEqual([
      { mode: "build", share: 50 },
      { mode: "plan", share: 50 },
    ]);
    expect(s.deepShare).toBe(50);
    expect(s.surfaces.map((x) => x.surface).sort()).toEqual(["app", "cli"]);
    // 53 weeks, Sunday→Saturday, ending with this week; days after today are padding.
    expect(s.weeks).toHaveLength(53);
    const last = s.weeks.at(-1)!;
    expect(last.map((d) => d.day)).toEqual([
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
    ]);
    expect(last.find((d) => d.day === "2026-10-12")).toMatchObject({ turns: 1 + 4 });
    expect(last.find((d) => d.day === "2026-10-15")).toMatchObject({
      turns: 2,
      inRange: true,
    });
    expect(last.find((d) => d.day === "2026-10-16")!.inRange).toBe(false);
    expect(s.monthLabels.filter(Boolean)).toContain("Oct");
  });

  it("counts what older builds still write to usage_stats, once", async () => {
    sqlite
      .prepare(
        "INSERT INTO usage_stats (day, surface, provider, model_id, mode, turns, deep_turns, input_tokens, output_tokens) VALUES ('2026-10-14', 'cli', 'deepseek', 'deepseek-chat', 'build', 3, 0, 300, 30)",
      )
      .run();
    await U.recordTurnUsage({
      model: { provider: "deepseek", name: "deepseek-chat" },
      mode: "build",
      deep: false,
      inputTokens: 100,
      outputTokens: 10,
      messages: [],
      surface: "cli",
      now: TODAY,
    });
    const s = await U.getActivityStats(TODAY);
    expect(s.lifetimeTokens).toBe(440);
    expect(s.recordedSince).toBe("2026-10-14");
    expect(s.totalTurns).toBe(4);
    expect(s.models).toEqual([{ provider: "deepseek", modelId: "deepseek-chat", turns: 4, share: 100 }]);
  });

  it("names the models of chats from before the rollup by what each chat had selected", async () => {
    sqlite
      .prepare("INSERT INTO chat_sessions (id, workspace_id, title, title_source, created_at, updated_at) VALUES ('old', 1, 'Old', 'user', 0, 0)")
      .run();
    const reply = (id: string, day: Date, model: unknown) =>
      sqlite
        .prepare(
          "INSERT INTO session_messages (id, session_id, role, content, created_at, display_snapshot) VALUES (?, 'old', 'assistant', 'ok', ?, ?)",
        )
        .run(id, Math.floor(day.getTime() / 1000), JSON.stringify({ model }));
    reply("r1", at(2026, 10, 1), { provider: "compass", name: "core-auto" });
    reply("r2", at(2026, 10, 2), { provider: "compass", name: "core-3" });
    reply("r3", at(2026, 10, 3), { provider: "anthropic", name: "claude-haiku-4-5" });
    // On or after the first rollup day, the rollup already has it.
    reply("r4", at(2026, 10, 15), { provider: "anthropic", name: "claude-haiku-4-5" });
    await U.recordTurnUsage({
      model: { provider: "compass", name: "atlarix/auto" },
      mode: "build",
      deep: false,
      inputTokens: 1,
      outputTokens: 1,
      messages: [],
      surface: "app",
      now: TODAY,
    });
    const s = await U.getActivityStats(TODAY);
    expect(s.models.map((m) => [m.provider, m.modelId, m.turns])).toEqual([
      ["compass", "atlarix/auto", 2],
      // A Core slot is never re-resolved to today's model.
      ["compass", "atlarix/core", 1],
      ["anthropic", "claude-haiku-4-5", 1],
    ]);
    expect(s.models[0]!.share).toBe(50);
  });

  it("is empty, not broken, on a new install", async () => {
    const s = await U.getActivityStats(TODAY);
    expect(s.since).toBeNull();
    expect(s.lifetimeTokens).toBe(0);
    expect(s.peakDay).toBeNull();
    expect(s.longestChat).toBeNull();
    expect(s.currentStreak).toBe(0);
    expect(s.models).toEqual([]);
  });
});

describe("streaks", () => {
  it("counts the run ending today, or yesterday while today is quiet", () => {
    const days = new Set(["2026-10-12", "2026-10-13", "2026-10-14"]);
    expect(U.streaks(days, at(2026, 10, 15))).toEqual({
      current: 3,
      longest: 3,
    });
    expect(U.streaks(days, at(2026, 10, 16))).toEqual({
      current: 0,
      longest: 3,
    });
    // Across a month end.
    expect(
      U.streaks(new Set(["2026-09-30", "2026-10-01"]), at(2026, 10, 1)).longest,
    ).toBe(2);
  });
});

describe("wiring", () => {
  it("every turn is recorded in finally, with its outcome, after it is reported", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.join(__dirname, "../ipc/handlers/chat_stream_handlers.ts"),
      "utf8",
    );
    const fin = src.indexOf("} finally {", src.indexOf("const runStream = async"));
    const reported = src.indexOf("trackTurnCompleted(", fin);
    const recorded = src.indexOf("recordLocalTurnUsage(ctx,", reported);
    expect(fin).toBeGreaterThan(-1);
    expect(reported).toBeGreaterThan(fin);
    expect(recorded).toBeGreaterThan(reported);
    expect(src.slice(recorded, recorded + 200)).toContain('ended.outcome === "ok"');
    // The old save-path-only call is gone: a stopped turn reaches the record too.
    expect(src).not.toContain("recordTurnUsageSafely({");
    const finalize = fs.readFileSync(
      path.join(__dirname, "../ipc/handlers/chat_stream/turn-runner/finalize.ts"),
      "utf8",
    );
    expect(finalize).toContain("ctx.turnAuxUsage = auxUsage;");
  });
});
