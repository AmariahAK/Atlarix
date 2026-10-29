import { describe, expect, it, vi } from "vitest";

/**
 * /usage in an editor without an Atlarix panel (Zed, JetBrains): this
 * computer's usage needs no sign-in; only the Credits part does.
 */

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

const { activityCalendar } = await import("@/lib/stats/usage-stats");
const { buildUsageReport } = await import("@/lib/stats/usage-report");
const NOW = new Date(2026, 9, 29, 18);
const overview = {
  since: "2026-10-01",
  recordedSince: "2026-10-20",
  lifetimeTokens: 5000,
  peakDay: { day: "2026-10-29", tokens: 5000 },
  longestChat: null,
  currentStreak: 1,
  longestStreak: 2,
  totalChats: 1,
  totalTurns: 3,
  ...activityCalendar(new Map([["2026-10-29", 3]]), NOW),
  models: [],
  modes: [],
  deepShare: 0,
  surfaces: [],
  editors: [],
  skills: [],
  mcp: [],
  linesWritten: 0,
  asOf: "2026-10-29",
};

const email = vi.fn<() => Promise<string | null>>();
vi.mock("@/cli/agent/services", () => ({
  realServices: {
    account: { email: () => email(), balanceCents: async () => null },
    usage: async () => buildUsageReport(overview, [], [], [], {}, NOW),
    usageCredits: async () => ({ state: "signed_out" }),
  },
}));

const { accountCommandText } = await import("@/cli/acp/account-commands");
const session = {
  appId: 1,
} as unknown as import("@/cli/agent/session").AgentSession;

describe("/usage in an editor chat", () => {
  it("answers signed out, from this computer", async () => {
    email.mockResolvedValue(null);
    const text = await accountCommandText("usage", session);
    expect(text).toContain("**Your activity**");
    expect(text).toContain("Sign in to see Atlarix credits.");
    expect(text).not.toContain("You're not signed in");
  });

  it("still answers /stats, the old name", async () => {
    email.mockResolvedValue(null);
    expect(await accountCommandText("stats", session)).toContain(
      "**Your activity**",
    );
  });
});
