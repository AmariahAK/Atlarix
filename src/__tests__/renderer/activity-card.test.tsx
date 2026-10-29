/**
 * The Usage page's Overview ("Your activity"): the numbers, the calendar and the
 * ranked lists, from this computer's stats (lib/stats/usage-stats).
 */
import React from "react";
import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./helpers";

const stats = {
  since: "2026-09-01",
  recordedSince: "2026-10-15",
  lifetimeTokens: 472_400_000,
  peakDay: { day: "2026-10-14", tokens: 68_700_000 },
  longestChat: { title: "Fix login", minutes: 84 },
  currentStreak: 3,
  longestStreak: 5,
  totalChats: 96,
  totalTurns: 1234,
  weeks: Array.from({ length: 53 }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => ({
      day: `2026-w${w}-${d}`,
      turns: w === 52 && d === 3 ? 9 : 0,
      level: w === 52 && d === 3 ? 4 : 0,
      inRange: true,
    })),
  ),
  monthLabels: Array.from({ length: 53 }, (_, w) => (w === 49 ? "Oct" : null)),
  models: [
    {
      provider: "compass",
      modelId: "openai/gpt-5.4-mini",
      turns: 10,
      share: 93,
    },
  ],
  modes: [{ mode: "ask", share: 100 }],
  deepShare: 0,
  surfaces: [{ surface: "editor", turns: 10 }],
  editors: [],
  skills: [{ name: "release", runs: 7 }],
  mcp: [{ name: "deepwiki", runs: 4 }],
  linesWritten: 0,
  asOf: "2026-10-15",
};

import { ActivityCard } from "@/components/settings/ActivityCard";

describe("Your activity", () => {
  it("shows the numbers, the calendar and what you use most", async () => {
    renderWithProviders(<ActivityCard data={stats as never} />);
    expect(await screen.findByText("472.4M")).toBeTruthy();
    expect(screen.getByText("Lifetime tokens")).toBeTruthy();
    expect(screen.getByText("1h 24m")).toBeTruthy();
    expect(screen.getByText("3 days")).toBeTruthy();
    expect(screen.getByLabelText("2026-w52-3: 9 turns")).toBeTruthy();
    expect(screen.getByText("Explore")).toBeTruthy();
    expect(screen.getByText("deepwiki")).toBeTruthy();
    expect(screen.getByText("4 calls")).toBeTruthy();
    expect(screen.getByText("Editors (VS Code, Zed, JetBrains)")).toBeTruthy();
    expect(screen.getByText(/count from 2026-10-15/)).toBeTruthy();
  });
});
