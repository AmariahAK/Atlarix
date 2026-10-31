/**
 * The Usage page: tokens per day stacked by model, its filters, MCP and skills,
 * Auto picks (never naming a gateway), the BYOK estimate, the CLI's text, the
 * share card and the Credits tab's reading of the account RPC.
 */
import { describe, expect, it, vi } from "vitest";

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
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/auth/supabase-client", () => ({
  getSession: vi.fn(),
  getSupabaseClient: vi.fn(),
}));

const R = await import("@/lib/stats/usage-report");
const Fm = await import("@/lib/stats/usage-format");
const { shareCardSvg } = await import("@/lib/stats/share-card");
const {
  parseUsageCredits,
  parseUsageTeam,
  parsePaidForMe,
  daysSinceLastMonthStart,
  monthKeys,
  channelLabel,
} = await import("@/lib/billing/usage-credits");
const { activityCalendar } = await import("@/lib/stats/usage-stats");
import type { ActivityStats } from "@/lib/stats/usage-types";
import type { UsageRollupRow } from "@/lib/stats/usage-stats";

const NOW = new Date(2026, 9, 29, 18);

const overview: ActivityStats = {
  since: "2026-09-01",
  recordedSince: "2026-10-20",
  lifetimeTokens: 1_234_567,
  peakDay: { day: "2026-10-28", tokens: 900_000 },
  longestChat: { title: "Secret project", minutes: 42 },
  currentStreak: 4,
  longestStreak: 9,
  totalChats: 12,
  totalTurns: 80,
  ...activityCalendar(
    new Map([
      ["2026-10-28", 5],
      ["2026-10-29", 2],
    ]),
    NOW,
  ),
  models: [
    {
      provider: "anthropic",
      modelId: "claude-sonnet-5-5",
      turns: 5,
      share: 100,
    },
  ],
  modes: [{ mode: "build", share: 100 }],
  deepShare: 0,
  surfaces: [{ surface: "app", turns: 5 }],
  editors: [],
  skills: [{ name: "private-release-skill", runs: 3 }],
  mcp: [{ name: "acme-internal-mcp", runs: 2 }],
  linesWritten: 10,
  asOf: "2026-10-29",
};

let id = 0;
const row = (over: Partial<UsageRollupRow>): UsageRollupRow => ({
  id: ++id,
  day: "2026-10-29",
  surface: "app",
  editor: "",
  source: "chat",
  provider: "anthropic",
  modelId: "claude-sonnet-5-5",
  mode: "build",
  turns: 1,
  deepTurns: 0,
  inputTokens: 100,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  estCostMicros: 0,
  pricedTurns: 0,
  unpricedTurns: 0,
  ...over,
});

describe("tokens", () => {
  it("stacks a window of local days by model: five, then Other", () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      row({ modelId: `model-${i}`, inputTokens: (i + 1) * 100 }),
    );
    const r = R.buildUsageReport(overview, rows, [], [], {}, NOW);
    expect(r.days).toHaveLength(30);
    expect(r.days.at(-1)).toBe("2026-10-29");
    expect(r.tokens.series.map((s) => s.label)).toEqual([
      "Model 6 (anthropic)",
      "Model 5 (anthropic)",
      "Model 4 (anthropic)",
      "Model 3 (anthropic)",
      "Model 2 (anthropic)",
      "Other",
    ]);
    const today = r.tokens.byDay.at(-1)!.values;
    expect(today).toEqual([700, 600, 500, 400, 300, 300]);
    expect(r.tokens.total).toBe(2800);
  });

  it("filters by model, surface and source, and ignores a filter it doesn't know", () => {
    const rows = [
      row({ surface: "cli", inputTokens: 10 }),
      row({ surface: "editor", editor: "zed", inputTokens: 20 }),
      row({ source: "subagent", turns: 0, inputTokens: 40 }),
      row({ provider: "compass", modelId: "atlarix/auto", inputTokens: 80 }),
    ];
    const by = (f: Parameters<typeof R.buildUsageReport>[4]) =>
      R.buildUsageReport(overview, rows, [], [], f, NOW).tokens.total;
    expect(by({})).toBe(150);
    expect(by({ surface: "zed" })).toBe(20);
    expect(by({ source: "subagent" })).toBe(40);
    expect(by({ model: "compass\u0000atlarix/auto" })).toBe(80);
    expect(by({ surface: "nowhere" })).toBe(150);
    const f = R.buildUsageReport(
      overview,
      rows,
      [],
      [],
      { surface: "zed" },
      NOW,
    ).filters;
    // Every option stays listed while one is applied.
    expect(f.surfaces.map((s) => s.label).sort()).toEqual([
      "App",
      "CLI",
      "Zed",
    ]);
    expect(f.sources.map((s) => s.label).sort()).toEqual([
      "Chats",
      "Sub-agents",
    ]);
    expect(f.models.map((m) => m.label)).toContain("Atlarix Auto");
  });

  it("labels your own provider's models with its name", () => {
    const r = R.buildUsageReport(
      { ...overview, providerNames: { "custom::qa": "My Proxy" } },
      [row({ provider: "custom::qa", modelId: "some-model" })],
      [],
      [],
      {},
      NOW,
    );
    expect(r.filters.models[0]!.label).toContain("My Proxy");
    expect(r.tokens.series[0]!.label).not.toContain("custom::");
  });

  it("takes 90 or 365 days, and anything else as 30", () => {
    expect(
      R.buildUsageReport(overview, [], [], [], { days: 365 }, NOW).days,
    ).toHaveLength(365);
    expect(
      R.buildUsageReport(overview, [], [], [], { days: 7 }, NOW).range,
    ).toBe(30);
  });

  it("estimates BYOK cost only from priced rows, and says how many had no price", () => {
    const rows = [
      row({ estCostMicros: 1_500_000, pricedTurns: 3 }),
      row({
        day: "2026-10-28",
        estCostMicros: 250_000,
        pricedTurns: 1,
        unpricedTurns: 2,
      }),
      row({ provider: "compass", modelId: "atlarix/auto" }),
    ];
    const r = R.buildUsageReport(overview, rows, [], [], {}, NOW);
    expect(r.byok).toMatchObject({
      totalUsd: 1.75,
      pricedTurns: 4,
      unpricedTurns: 2,
      since: "2026-10-28",
    });
    expect(r.byok!.byDay.at(-1)).toEqual({ day: "2026-10-29", usd: 1.5 });
    // Nothing priced: no estimate at all rather than "$0.00".
    expect(
      R.buildUsageReport(overview, [row({ unpricedTurns: 4 })], [], [], {}, NOW)
        .byok,
    ).toBeNull();
  });
});

describe("MCP & skills and Auto picks", () => {
  it("counts calls per day and ranks the servers and skills", () => {
    const r = R.buildUsageReport(
      overview,
      [],
      [
        { day: "2026-10-29", kind: "mcp", name: "deepwiki", runs: 3 },
        { day: "2026-10-29", kind: "skill", name: "release", runs: 1 },
        { day: "2026-08-01", kind: "mcp", name: "old", runs: 9 },
      ],
      [],
      {},
      NOW,
    );
    expect(r.tools.byDay.at(-1)).toEqual({
      day: "2026-10-29",
      mcp: 3,
      skill: 1,
    });
    expect(r.tools.mcp).toEqual([{ name: "deepwiki", runs: 3 }]);
  });

  it("names only models Auto's own config lists; gateways read as other models", () => {
    const nameable = new Set(["gpt-5.4-mini", "claude-haiku-5-5"]);
    const picks = [
      {
        day: "2026-10-29",
        billing: "free",
        tier: "auto",
        servedModel: "gpt-5.4-mini",
        steps: 6,
      },
      {
        day: "2026-10-29",
        billing: "free",
        tier: "auto",
        servedModel: "openrouter/free",
        steps: 2,
      },
      {
        day: "2026-10-29",
        billing: "free",
        tier: "auto",
        servedModel: "meta-llama/llama-4:free",
        steps: 1,
      },
      {
        day: "2026-10-29",
        billing: "paid",
        tier: "auto",
        servedModel: "claude-haiku-5-5",
        steps: 1,
      },
    ];
    const r = R.buildUsageReport(overview, [], [], picks, {}, NOW, nameable);
    expect(r.autoPicks.steps).toBe(10);
    expect(r.autoPicks.models).toEqual([
      {
        label: "GPT-5.4 Mini",
        billing: "free",
        tier: "auto",
        steps: 6,
        share: 60,
      },
      {
        label: "Other free models",
        billing: "free",
        tier: "auto",
        steps: 3,
        share: 30,
      },
      {
        label: "Claude Haiku 5.5",
        billing: "paid",
        tier: "auto",
        steps: 1,
        share: 10,
      },
    ]);
    expect(JSON.stringify(r.autoPicks)).not.toMatch(/openrouter|llama/i);
    expect(r.autoPicks.byDay.at(-1)).toEqual({
      day: "2026-10-29",
      free: 9,
      paid: 1,
    });
  });
});

describe("as text (CLI and ACP)", () => {
  it("fits every tab in an 80-column terminal", () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      row({
        day: R.windowDays(30, NOW)[i]!,
        modelId: `a-very-long-model-name-${i % 7}`,
        inputTokens: 1000 * (i + 1),
      }),
    );
    const r = R.buildUsageReport(
      overview,
      rows,
      [{ day: "2026-10-29", kind: "mcp", name: "x".repeat(60), runs: 2 }],
      [],
      {},
      NOW,
    );
    for (const lines of [Fm.tokensText(r), Fm.toolsText(r), Fm.autoText(r)]) {
      for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(80);
    }
  });

  it("draws a name recorded before names were cleaned without its escape codes", () => {
    const r = R.buildUsageReport(
      overview,
      [],
      [
        {
          day: "2026-10-29",
          kind: "mcp",
          name: "x\u001b]0;pwned\u0007",
          runs: 1,
        },
      ],
      [],
      {},
      NOW,
    );
    const lines = Fm.toolsText(r).map((l) => l.text);
    expect(lines.some((l) => l.includes("x]0;pwned"))).toBe(true);
    // eslint-disable-next-line no-control-regex -- looking for them is the point
    for (const l of lines) expect(l).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("packs the key onto lines that fit, never breaking a model's name", () => {
    const lines = Fm.legend(
      [
        "Claude Opus 5.5 (anthropic)",
        "DeepSeek Flash (deepseek)",
        "Claude Haiku 5.5 (anthropic)",
        "Other",
      ],
      60,
    ).map((l) => l.text);
    expect(lines).toEqual([
      "█ Claude Opus 5.5 (anthropic)   ▓ DeepSeek Flash (deepseek)",
      "▒ Claude Haiku 5.5 (anthropic)   ░ Other",
    ]);
  });

  it("draws a stacked bar in proportion, scaled to the busiest day", () => {
    expect(Fm.stackedBar([30, 10], 40, 8)).toBe("██████▓▓");
    expect(Fm.stackedBar([10], 40, 8)).toBe("██");
    expect(Fm.stackedBar([0, 0], 40, 8)).toBe("");
  });

  it("says why a tab is empty", () => {
    const empty = R.buildUsageReport(
      { ...overview, since: null },
      [],
      [],
      [],
      {},
      NOW,
    );
    expect(Fm.tokensText(empty)[0]!.text).toBe(
      "Tokens are counted from your next chat.",
    );
    expect(Fm.autoText(empty)[0]!.text).toBe(
      "Atlarix Auto's picks count from its next reply on this computer.",
    );
    expect(Fm.creditsText({ state: "signed_out" })[0]!.text).toBe(
      "Sign in to see Atlarix credits.",
    );
  });
});

describe("the share card", () => {
  it("shows the year, the streaks and tokens, and nothing private", () => {
    const svg = shareCardSvg(overview);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("4 days");
    expect(svg).toContain("9 days");
    expect(svg).toContain("1.2M");
    // The partial first month gives way to the next one: never "OctNov".
    const labels = [
      ...svg.matchAll(
        /<text x="(\d+)" y="\d+" font-size="16" fill="#8b9a90">([A-Z][a-z]{2})<\/text>/g,
      ),
    ].map((m) => Number(m[1]));
    for (let i = 1; i < labels.length; i++)
      expect(labels[i]! - labels[i - 1]!).toBeGreaterThanOrEqual(3 * 21);
    for (const secret of [
      "Secret project",
      "private-release-skill",
      "acme-internal-mcp",
      "claude",
      "Sonnet",
    ]) {
      expect(svg).not.toContain(secret);
    }
  });
});

describe("Credits", () => {
  it("reads the account RPC, and anything malformed as unavailable rather than $0", () => {
    const c = parseUsageCredits({
      ok: true,
      balance_cents: 1234,
      purchased_cents: 1000,
      granted_cents: 234,
      granted_total_cents: 1900,
      plan: "pro",
      renews_at: "2026-11-20T00:00:00Z",
      since: "2026-10-01",
      days: [
        {
          day: "2026-10-29",
          auto_paid_cents: 12,
          core_cents: 30,
          tool_cents: 1,
          other_cents: 0,
          unsplit_cents: 0,
        },
        { day: "2026-10-28", auto_paid_cents: -5, core_cents: 2.4 },
        { nope: true },
      ],
    });
    expect(c).toMatchObject({
      state: "ok",
      balanceCents: 1234,
      plan: "pro",
      renewsAt: "2026-11-20T00:00:00Z",
    });
    if (c.state !== "ok") throw new Error("unreachable");
    expect(c.days).toEqual([
      {
        day: "2026-10-28",
        autoPaidCents: 0,
        coreCents: 2,
        toolCents: 0,
        otherCents: 0,
        unsplitCents: 0,
      },
      {
        day: "2026-10-29",
        autoPaidCents: 12,
        coreCents: 30,
        toolCents: 1,
        otherCents: 0,
        unsplitCents: 0,
      },
    ]);
    expect(parseUsageCredits(null)).toEqual({ state: "unavailable" });
    expect(parseUsageCredits({ ok: false, error: "account_banned" })).toEqual({
      state: "unavailable",
    });
    expect(parseUsageCredits({ ok: true })).toEqual({ state: "unavailable" });
  });

  it("reads the live RPC's body while every debit is still unsplit", () => {
    // get_usage_credits as applied (20261029130000), before the proxy passes p_billing.
    const c = parseUsageCredits({
      ok: true,
      balance_cents: 812,
      purchased_cents: 812,
      granted_cents: 0,
      granted_total_cents: 0,
      plan: "free",
      renews_at: null,
      since: "2026-10-02",
      days: [
        {
          day: "2026-10-28",
          auto_paid_cents: 0,
          core_cents: 0,
          tool_cents: 0,
          other_cents: 0,
          unsplit_cents: 37,
        },
        {
          day: "2026-10-29",
          auto_paid_cents: 0,
          core_cents: 0,
          tool_cents: 0,
          other_cents: 0,
          unsplit_cents: 151,
        },
      ],
    });
    expect(c).toMatchObject({
      state: "ok",
      plan: "free",
      renewsAt: null,
      since: "2026-10-02",
    });
    const text = Fm.creditsText(c).map((l) => l.text);
    expect(text[0]).toBe("Balance $8.12");
    // No Pro line for a free account; today's spend is "Not split", never called "earlier".
    expect(text.join("\n")).not.toContain("Pro allowance");
    // Only series with spend are drawn: no "Auto", "Core" or "Search" key for nothing.
    expect(text.at(-1)).toBe("█ Not split");
    expect(text.find((l) => l.startsWith("Oct 29"))).toMatch(/█+ \$1\.51$/);
  });

  it("shows the Pro allowance and splits Auto from Core in the text", () => {
    const c = parseUsageCredits({
      ok: true,
      balance_cents: 500,
      granted_cents: 400,
      granted_total_cents: 1900,
      plan: "pro",
      days: [{ day: "2026-10-29", auto_paid_cents: 100, core_cents: 50 }],
    });
    const text = Fm.creditsText(c).map((l) => l.text);
    expect(text[0]).toBe("Balance $5.00");
    expect(text[1]).toContain("$15.00 of $19.00 used");
    expect(text.at(-1)).toContain("█ Auto");
    expect(text.at(-1)).toContain("▓ Core");
  });
});

describe("workspace pays (Slack) in the Credits tab", () => {
  const now = new Date(2026, 9, 30, 12); // Oct 30, local

  it("asks for every day back to the first of last month", () => {
    expect(monthKeys(now)).toEqual({
      thisMonth: "2026-10",
      lastMonth: "2026-09",
    });
    // Sep 1 00:00 to Oct 30 12:00 is 59.5 days: rounded up, plus a day so the first is never cut.
    expect(daysSinceLastMonthStart(now)).toBe(61);
    expect(monthKeys(new Date(2026, 0, 5))).toEqual({
      thisMonth: "2026-01",
      lastMonth: "2025-12",
    });
  });

  it("splits the payer's team spend by member and channel, this month and last", () => {
    const team = parseUsageTeam(
      {
        ok: true,
        rows: [
          {
            day: "2026-10-29",
            member: "dana",
            member_id: "u1",
            team_id: "T1",
            channel: "C-eng",
            cents: 120,
          },
          {
            day: "2026-10-02",
            member: "dana",
            member_id: "u1",
            team_id: "T1",
            channel: null,
            cents: 30,
          },
          {
            day: "2026-09-15",
            member: "lee",
            member_id: "u2",
            team_id: "T1",
            channel: "C-eng",
            cents: 40,
          },
          // Older than last month: not shown.
          {
            day: "2026-08-31",
            member: "lee",
            member_id: "u2",
            team_id: "T1",
            channel: "C-eng",
            cents: 999,
          },
        ],
        members: [
          { member: "dana", member_id: "u1", cents: 150, tasks: 3 },
          { member: "lee", member_id: "u2", cents: 40, tasks: 1 },
        ],
      },
      now,
    );
    expect(team).toEqual({
      members: [
        { member: "dana", tasks: 3, thisMonthCents: 150, lastMonthCents: 0 },
        { member: "lee", tasks: 1, thisMonthCents: 0, lastMonthCents: 40 },
      ],
      channels: [
        { channel: "#C-eng", thisMonthCents: 120, lastMonthCents: 40 },
        { channel: "Direct messages", thisMonthCents: 30, lastMonthCents: 0 },
      ],
    });
    // Paying for no one: no Team section at all.
    expect(
      parseUsageTeam({ ok: true, rows: [], members: [] }, now),
    ).toBeUndefined();
    expect(
      parseUsageTeam({ ok: false, error: "not_authenticated" }, now),
    ).toBeUndefined();
  });

  it('labels channels as ai-8b sends them: "eng" reads #eng, "dm" and none read Direct messages', () => {
    expect(channelLabel("eng")).toBe("#eng");
    expect(channelLabel("#eng")).toBe("#eng");
    expect(channelLabel("dm")).toBe("Direct messages");
    expect(channelLabel("DM")).toBe("Direct messages");
    expect(channelLabel(null)).toBe("Direct messages");
    expect(channelLabel("  ")).toBe("Direct messages");
  });

  it("shows one block per Slack workspace when a pot pays for several", () => {
    const team = parseUsageTeam(
      {
        ok: true,
        rows: [
          {
            day: "2026-10-29",
            member: "dana",
            team_id: "T1",
            team_name: "Norah Labs",
            channel: "eng",
            cents: 300,
          },
          {
            day: "2026-10-29",
            member: "lee",
            team_id: "T1",
            team_name: "Norah Labs",
            channel: "dm",
            cents: 100,
          },
          {
            day: "2026-10-28",
            member: "sam",
            team_id: "T2",
            team_name: "Side Project",
            channel: "general",
            cents: 50,
          },
        ],
        members: [],
        teams: [],
      },
      now,
    );
    expect(
      team?.workspaces?.map((w) => [w.teamName, w.people, w.thisMonthCents]),
    ).toEqual([
      ["Norah Labs", 2, 400],
      ["Side Project", 1, 50],
    ]);
    const base = parseUsageCredits({ ok: true, balance_cents: 0, days: [] });
    if (base.state !== "ok") throw new Error("unreachable");
    const sections = Fm.creditsTeamSections({ ...base, team });
    expect(sections.map((x) => x.title)).toEqual([
      "Norah Labs · $4.00 this month · 2 people",
      "Side Project · $0.50 this month · 1 person",
    ]);
    expect(sections[0]!.rows.map((r) => r.label)).toEqual([
      "dana",
      "lee",
      "#eng",
      "Direct messages",
    ]);
  });

  it('reads a DM sent as "dm" the same as one with no channel', () => {
    const team = parseUsageTeam(
      {
        ok: true,
        rows: [
          { day: "2026-10-02", member: "dana", channel: null, cents: 20 },
          { day: "2026-10-03", member: "dana", channel: "dm", cents: 10 },
          { day: "2026-10-03", member: "dana", channel: "#eng", cents: 5 },
        ],
        members: [],
      },
      now,
    );
    expect(team?.channels.map((c) => [c.channel, c.thisMonthCents])).toEqual([
      ["Direct messages", 30],
      ["#eng", 5],
    ]);
  });

  it("shows what a workspace paid for you, and the payer's team, in the text", () => {
    const paid = parsePaidForMe(
      {
        ok: true,
        rows: [
          { day: "2026-10-30", team_id: "T1", team_name: "Acme", cents: 55 },
        ],
      },
      now,
    );
    expect(paid).toEqual([
      { teamName: "Acme", thisMonthCents: 55, lastMonthCents: 0 },
    ]);
    const base = parseUsageCredits({ ok: true, balance_cents: 1000, days: [] });
    if (base.state !== "ok") throw new Error("unreachable");
    const c = {
      ...base,
      paidForMe: paid,
      team: {
        members: [
          { member: "dana", tasks: 2, thisMonthCents: 150, lastMonthCents: 0 },
        ],
        channels: [],
      },
    };
    const text = Fm.creditsText(c).map((l) => l.text);
    expect(text).toContain("Team · people you pay for");
    expect(
      text.some(
        (l) =>
          l.includes("dana (2 tasks)") &&
          l.includes("$1.50 this month · — last month"),
      ),
    ).toBe(true);
    expect(text).toContain("Paid for you");
    expect(
      text.some(
        (l) => l.includes("Paid by Acme") && l.includes("$0.55 this month"),
      ),
    ).toBe(true);
    for (const l of text) expect(l.length).toBeLessThanOrEqual(80);
    // Without either: no team sections.
    expect(Fm.creditsTeamSections(base)).toEqual([]);
  });
});
