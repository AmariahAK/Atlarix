/**
 * The app's Usage page: the overview with the share card, then each tab from
 * the report (lib/stats/usage-report) and the account's credits.
 */
import React from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "./helpers";

vi.mock("@/components/settings/SettingsWorkspaceNav", () => ({
  SettingsWorkspaceNav: () => null,
}));
vi.mock("@/components/settings/EditStatsCard", () => ({
  EditStatsCard: () => null,
}));

const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
const days = Array.from({ length: 30 }, (_, i) => day(i + 1));
const report = {
  overview: {
    since: "2026-09-01",
    recordedSince: "2026-10-20",
    lifetimeTokens: 2_500_000,
    peakDay: { day: "2026-10-28", tokens: 900_000 },
    longestChat: { title: "x", minutes: 30 },
    currentStreak: 2,
    longestStreak: 4,
    totalChats: 3,
    totalTurns: 9,
    weeks: [[{ day: "2026-10-28", turns: 3, level: 4, inRange: true }]],
    monthLabels: ["Oct"],
    models: [],
    modes: [],
    deepShare: 0,
    surfaces: [],
    editors: [],
    skills: [],
    mcp: [],
    linesWritten: 0,
    asOf: "2026-10-30",
  },
  range: 30,
  days,
  filters: {
    models: [
      {
        key: "anthropic\u0000claude-sonnet-5-5",
        label: "Claude Sonnet 5.5 (anthropic)",
      },
    ],
    surfaces: [{ key: "app", label: "App" }],
    sources: [{ key: "chat", label: "Chats" }],
    applied: { model: null, surface: null, source: null },
  },
  tokens: {
    series: [
      {
        key: "anthropic\u0000claude-sonnet-5-5",
        label: "Claude Sonnet 5.5 (anthropic)",
      },
    ],
    byDay: days.map((d) => ({
      day: d,
      values: [d === "2026-10-30" ? 1200 : 0],
    })),
    total: 1200,
    since: "2026-10-20",
  },
  tools: {
    byDay: days.map((d) => ({ day: d, mcp: 0, skill: 0 })),
    mcp: [],
    skills: [],
  },
  autoPicks: {
    steps: 4,
    models: [
      {
        label: "GPT 5.4 Mini",
        billing: "free",
        tier: "auto",
        steps: 4,
        share: 100,
      },
    ],
    byDay: days.map((d) => ({
      day: d,
      free: d === "2026-10-30" ? 4 : 0,
      paid: 0,
    })),
    since: "2026-10-25",
  },
  byok: {
    totalUsd: 0.42,
    byDay: [],
    pricedTurns: 3,
    unpricedTurns: 1,
    since: "2026-10-21",
  },
};
const getUsageReport = vi.fn(async () => report);
const getUsageCredits = vi.fn(
  async (): Promise<unknown> => ({ state: "signed_out" }),
);
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: {
    getInstance: () => ({
      getUsageReport,
      getUsageCredits,
      saveUsageCard: vi.fn(),
    }),
  },
}));

import { UsagePage } from "@/pages/usage";

const open = (name: string) =>
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });

describe("Usage", () => {
  beforeEach(() => {
    getUsageCredits.mockClear();
    getUsageReport.mockClear();
  });

  it("shows a payer the people and channels it pays for in Credits", async () => {
    getUsageCredits.mockResolvedValueOnce({
      state: "ok",
      balanceCents: 900,
      purchasedCents: 900,
      grantedCents: 0,
      grantedTotalCents: 0,
      plan: "free",
      renewsAt: null,
      since: "2026-10-01",
      days: [],
      team: {
        members: [
          { member: "dana", tasks: 2, thisMonthCents: 150, lastMonthCents: 0 },
        ],
        channels: [
          {
            channel: "Direct messages",
            thisMonthCents: 150,
            lastMonthCents: 0,
          },
        ],
      },
    } as never);
    renderWithProviders(<UsagePage />);
    await screen.findByText("2.5M");
    open("Credits");
    expect(await screen.findByText("Team · people you pay for")).toBeTruthy();
    expect(screen.getByText("dana (2 tasks)")).toBeTruthy();
    expect(screen.getAllByText("$1.50 this month · — last month")).toHaveLength(
      2,
    );
  });

  it("opens on the overview, with the share card", async () => {
    renderWithProviders(<UsagePage />);
    expect(await screen.findByText("2.5M")).toBeTruthy();
    expect(screen.getByText("Copy share card")).toBeTruthy();
    expect(screen.getByText("Save share card")).toBeTruthy();
    // Credits are the account's: not asked for until the tab opens.
    expect(getUsageCredits).not.toHaveBeenCalled();
  });

  it("shows tokens with filters and the BYOK estimate marked as one", async () => {
    renderWithProviders(<UsagePage />);
    await screen.findByText("2.5M");
    open("Tokens");
    expect(await screen.findByText("1.2K tokens")).toBeTruthy();
    expect(screen.getByLabelText("Model")).toBeTruthy();
    // One "30 days", the default, selected (QA 2 E1: it was listed twice).
    const range = screen.getByLabelText("Range") as HTMLSelectElement;
    expect([...range.options].map((o) => o.text)).toEqual([
      "30 days",
      "90 days",
      "12 months",
    ]);
    expect(range.value).toBe("");
    expect(screen.getByText("Your own keys: about $0.42")).toBeTruthy();
    expect(
      screen.getByText(/An estimate at list price, not a bill/),
    ).toBeTruthy();
    expect(
      screen.getByText(/1 turns on models without a reliable price/),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Surface"), {
      target: { value: "app" },
    });
    await vi.waitFor(() =>
      expect(getUsageReport).toHaveBeenLastCalledWith({ surface: "app" }),
    );
  });

  it("shows which models Auto picked, and asks for credits only on Credits", async () => {
    renderWithProviders(<UsagePage />);
    await screen.findByText("2.5M");
    open("Auto");
    expect(await screen.findByText("GPT 5.4 Mini · Free")).toBeTruthy();
    open("Credits");
    expect(
      await screen.findByText("Sign in to see Atlarix credits."),
    ).toBeTruthy();
    expect(getUsageCredits).toHaveBeenCalled();
  });
});
