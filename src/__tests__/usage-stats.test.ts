/**
 * Your activity: what a finished turn records, and what the stats page reads
 * back — on a real database with every migration applied.
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
    const rows = sqlite.prepare("SELECT * FROM usage_stats").all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: "2026-10-15",
      surface: "cli",
      turns: 2,
      deep_turns: 1,
      input_tokens: 1500,
      output_tokens: 250,
    });
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
    expect(s.totalChats).toBe(2);
    expect(s.totalTurns).toBe(5 + 2);
    expect(s.longestChat).toEqual({
      title: "Fix the login bug",
      minutes: (2 * 24 + 3) * 60,
    });
    expect(s.models.map((m) => [m.modelId, m.share])).toEqual([
      ["openai/gpt-5.4-mini", 50],
      ["deepseek-chat", 50],
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
    expect(last.find((d) => d.day === "2026-10-15")).toMatchObject({
      turns: 2,
      inRange: true,
    });
    expect(last.find((d) => d.day === "2026-10-16")!.inRange).toBe(false);
    expect(s.monthLabels.filter(Boolean)).toContain("Oct");
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
  it("every finished turn is recorded, right after it is saved", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.join(__dirname, "../ipc/handlers/chat_stream_handlers.ts"),
      "utf8",
    );
    const saved = src.indexOf("await finalizeTurn(ctx, {");
    const recorded = src.indexOf("recordTurnUsageSafely({", saved);
    expect(saved).toBeGreaterThan(-1);
    expect(recorded).toBeGreaterThan(saved);
    expect(src.slice(recorded, recorded + 600)).toContain(
      "ctx.nativeTurnMessages",
    );
  });
});
