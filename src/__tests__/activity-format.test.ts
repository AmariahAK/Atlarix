import { describe, expect, it, vi } from "vitest";

/**
 * "Your activity" as text, the same in the CLI's and ACP's /stats: the numbers
 * along the top, a shaded calendar that fits a terminal, and the sections.
 */

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
    }),
  },
}));
vi.mock("@/db", () => ({ db: {} }));

const F = await import("@/lib/stats/activity-format");
const { activityCalendar } = await import("@/lib/stats/usage-stats");
import type { ActivityStats } from "@/lib/stats/usage-stats";

const today = new Date(2026, 9, 15, 20);
const stats = (over: Partial<ActivityStats> = {}): ActivityStats => ({
  since: "2026-09-01",
  recordedSince: "2026-10-15",
  lifetimeTokens: 472_400_000,
  peakDay: { day: "2026-10-14", tokens: 68_700_000 },
  longestChat: { title: "Fix login", minutes: 84 },
  currentStreak: 3,
  longestStreak: 5,
  totalChats: 96,
  totalTurns: 1234,
  ...activityCalendar(
    new Map([
      ["2026-10-13", 3],
      ["2026-10-14", 9],
      ["2026-10-15", 1],
    ]),
    today,
  ),
  models: [
    {
      provider: "compass",
      modelId: "openai/gpt-5.4-mini",
      turns: 10,
      share: 93,
    },
  ],
  modes: [
    { mode: "build", share: 70 },
    { mode: "ask", share: 30 },
  ],
  deepShare: 12,
  surfaces: [
    { surface: "cli", turns: 7 },
    { surface: "editor", turns: 3 },
  ],
  editors: [],
  skills: [{ name: "release", runs: 7 }],
  mcp: [{ name: "deepwiki", runs: 4 }],
  linesWritten: 5000,
  asOf: "2026-10-15",
  ...over,
});

describe("numbers", () => {
  it("compacts big counts and reads durations", () => {
    expect([
      F.compactCount(472_400_000),
      F.compactCount(68_700),
      F.compactCount(950),
    ]).toEqual(["472.4M", "68.7K", "950"]);
    expect([
      F.durationLabel(12),
      F.durationLabel(84),
      F.durationLabel(3 * 1440 + 120),
    ]).toEqual(["12m", "1h 24m", "3d 2h"]);
    expect(F.activityModeLabel("ask")).toBe("Explore");
  });
});

describe("the calendar as text", () => {
  it("is a month row, Sunday→Saturday, and a key, one character a week", () => {
    const rows = F.calendarRows(stats());
    expect(rows).toHaveLength(9);
    expect(rows[1]!.startsWith("Su ")).toBe(true);
    expect(rows[1]!.length).toBe(3 + 53);
    expect(rows[0]).toContain("Oct");
    expect(rows.at(-1)).toBe("   Less · ░ ▒ ▓ █ More");
    // This week: Tuesday 13 (3), Wednesday 14 (9, the most), Thursday 15 (1); later days are blank.
    // Shaded by quartile of active days, as the Code written calendar does.
    const col = (d: number) => rows[1 + d]!.at(-1);
    expect([col(2), col(3), col(4), col(5)]).toEqual(["▒", "▓", "░", " "]);
  });

  it("keeps a space between month names", () => {
    const head = F.calendarRows({
      weeks: Array.from({ length: 7 }, () => []),
      monthLabels: ["Oct", null, "Nov", null, null, null, "Dec"],
    })[0]!;
    expect(head).not.toMatch(/OctNov|NovDec/);
    // The partial first month gives way; every full month keeps its name.
    expect(head.trim()).toBe("Nov Dec");
  });

  it("can be trimmed to fit (the editors show half a year)", () => {
    expect(F.calendarRows(stats(), 26)[1]!.length).toBe(3 + 26);
  });
});

describe("/stats in an editor", () => {
  it("is markdown with the calendar in a code block", () => {
    const md = F.statsMarkdown(stats());
    expect(md).toContain("**472.4M** lifetime tokens");
    expect(md).toContain("```\n");
    expect(md).toContain("- GPT 5.4 Mini (Atlarix Core): 93%".slice(0, 6));
    expect(md).toContain("**Most used MCP servers**\n\n- deepwiki: 4 calls");
    expect(md).toContain("- Explore: 30%");
    expect(md).toContain("_Stored only on this computer.");
  });

  it("says so when there's nothing yet", () => {
    expect(F.statsMarkdown(stats({ since: null }))).toContain("No activity yet.");
  });

  it("lists a named editor on its own and leaves the rest as Editors", () => {
    const rows = F.activitySections(
      stats({ surfaces: [{ surface: "editor", turns: 5 }], editors: [{ editor: "zed", turns: 3 }] }),
    ).find((x) => x.title === "Where you work")!.rows;
    expect(rows).toEqual([
      { label: "Editors (VS Code, Zed, JetBrains)", value: "2 turns" },
      { label: "Zed", value: "3 turns" },
    ]);
  });
});
