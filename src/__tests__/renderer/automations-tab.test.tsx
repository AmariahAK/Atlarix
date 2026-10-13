/**
 * Automations tab: definitions list renders, feed rows show status + unread
 * state, expanding a run marks it read, and the archived filter hides
 * auto-archived nothing-to-report runs.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { automationRunsAtom, automationsAtom } from "@/atoms/automationAtoms";
import { renderWithProviders } from "./helpers";
import type { AutomationRunView } from "@/lib/automations/types";

const listAutomations = vi.fn(async () => ({
  automations: [
    {
      id: "au-1",
      workspaceId: 7,
      name: "Nightly audit",
      enabled: true,
      trigger: { kind: "schedule", cron: "0 9 * * *" },
      prompt: "audit the tests",
      runMode: "read-only" as const,
      model: null,
      lastRunAt: Date.now() - 60_000,
      createdAt: Date.now() - 86_400_000,
    },
  ],
  unreadCount: 1,
}));
const runs: AutomationRunView[] = [
  {
    id: "run-1",
    automationId: "au-1",
    automationName: "Nightly audit",
    sessionId: "s-1",
    status: "ok",
    summary: "3 flaky tests found",
    error: null,
    unread: true,
    archived: false,
    triggerContext: "- New PR #43 by bob",
    startedAt: Date.now() - 30_000,
    finishedAt: Date.now() - 10_000,
  },
  {
    id: "run-2",
    automationId: "au-1",
    automationName: "Nightly audit",
    sessionId: "s-2",
    status: "nothing-to-report",
    summary: null,
    error: null,
    unread: false,
    archived: true,
    triggerContext: null,
    startedAt: Date.now() - 90_000,
    finishedAt: Date.now() - 80_000,
  },
];
const listAutomationRuns = vi.fn(async () => runs);
const markAutomationRunsRead = vi.fn(async () => ({ ok: true }));
const getCurrentBranch = vi.fn(async () => ({ branch: "main" }));
const listMcpServers = vi.fn(async () => []);
const onAutomationRunUpdate = vi.fn(() => () => {});
/** Fires when a definition changes anywhere — including the agent creating one. */
let automationsChangedHandler: (() => void) | null = null;
const onAutomationsChanged = vi.fn((h: () => void) => {
  automationsChangedHandler = h;
  return () => {
    automationsChangedHandler = null;
  };
});
const runAutomationNow = vi.fn(async () => ({ ok: true }));

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: {
    getInstance: () => ({
      listAutomations,
      listAutomationRuns,
      markAutomationRunsRead,
      getCurrentBranch,
      listMcpServers,
      onAutomationRunUpdate,
      onAutomationsChanged,
      runAutomationNow,
    }),
  },
}));

import { AutomationsTab } from "@/components/automations/AutomationsTab";

describe("AutomationsTab", () => {
  beforeEach(() => {
    const store = getDefaultStore();
    store.set(automationsAtom, []);
    store.set(automationRunsAtom, []);
    markAutomationRunsRead.mockClear();
  });

  it("renders definitions + unarchived feed rows; expanding marks read", async () => {
    renderWithProviders(<AutomationsTab appId={7} />);

    // Definition + feed row both load (same automation name appears twice).
    const rows = await screen.findAllByText("Nightly audit");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // As a person says it (QA #22), not "cron 0 9 * * *".
    expect(screen.getByText(/9:00 AM, every day/)).toBeTruthy();

    // Feed: archived nothing-to-report run hidden by default.
    expect(screen.queryByText(/nothing to report/i)).toBeNull();

    // Expand the run → summary appears + mark-read fires.
    fireEvent.click(rows[rows.length - 1]);
    expect(await screen.findByText(/3 flaky tests found/)).toBeTruthy();
    await waitFor(() => {
      expect(markAutomationRunsRead).toHaveBeenCalledWith(["run-1"]);
    });
  });

  // QA (app) #12: a run that found failing tests showed only a green "✓ ok",
  // which reads as "tests fine"; what it found was hidden until expanded.
  it("a run's row says what it found, without a green 'ok'", async () => {
    renderWithProviders(<AutomationsTab appId={7} />);
    await screen.findAllByText("Nightly audit");
    expect(screen.getByText("3 flaky tests found")).toBeTruthy();
    expect(screen.queryByText(/^\s*ok\s*$/)).toBeNull();
  });

  // QA #22: "No runs yet." beside "last run 1m ago" — the only run had been
  // archived (nothing to report).
  it("does not say 'No runs yet' when the runs are archived", async () => {
    listAutomationRuns.mockResolvedValueOnce([runs[1]!]);
    renderWithProviders(<AutomationsTab appId={7} />);
    expect(await screen.findByText("No new runs.")).toBeTruthy();
    expect(screen.queryByText(/No runs yet/)).toBeNull();
  });

  it("shows archived runs when the filter is on", async () => {
    renderWithProviders(<AutomationsTab appId={7} />);
    await screen.findAllByText("Nightly audit");
    fireEvent.click(screen.getByLabelText(/show archived/i));
    expect(await screen.findByText(/nothing to report/i)).toBeTruthy();
  });

  it("prompts to open a workspace when appId is null", () => {
    renderWithProviders(<AutomationsTab appId={null} />);
    expect(screen.getByText(/open a workspace/i)).toBeTruthy();
  });

  it("refetches when a definition changes elsewhere — e.g. the AGENT created one", async () => {
    // The observed gap: the agent created "Weekly cargo test on main", the
    // service logged it, and the panel stayed empty until something else made it
    // refetch. The IPC path never showed it because the tab refetches after its
    // OWN call; the tool writes in main.
    renderWithProviders(<AutomationsTab appId={7} />);
    await screen.findAllByText("Nightly audit");
    const before = listAutomations.mock.calls.length;

    expect(automationsChangedHandler).toBeTypeOf("function");
    await act(async () => {
      automationsChangedHandler?.();
    });

    expect(listAutomations.mock.calls.length).toBeGreaterThan(before);
  });
});
