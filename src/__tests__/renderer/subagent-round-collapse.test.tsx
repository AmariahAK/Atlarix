/**
 * A sub-agent's report is written for the PARENT AGENT — it's data passed between
 * models, not prose for the reader. While a round is live the open list is the
 * point (it's how you see what's happening); once every agent has settled, keeping
 * the reports expanded buries the actual answer under machine-to-machine output.
 *
 * So: live rounds stay open, settled rounds fold back to their one-line summary,
 * and a user who opens a settled round keeps it open.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { SubAgentRunEntry } from "@/lib/chat/stream-thread";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

import { SubAgentsRoundPanel } from "@/components/chat/subagent/SubAgentsRoundPanel";

const agent = (
  id: string,
  status: SubAgentRunEntry["status"],
): SubAgentRunEntry => ({
  id,
  agentType: "explorer",
  label: `explorer · ${id}`,
  scope: id,
  summary: `## Findings for ${id}\n\n- something`,
  status,
  nestedItems: [],
});

const renderPanel = (agents: SubAgentRunEntry[], isStreaming = false) =>
  renderWithProviders(
    <SubAgentsRoundPanel
      agents={agents}
      status={agents.some((a) => a.status === "running") ? "running" : "done"}
      isStreaming={isStreaming}
    />,
  );

/** The per-agent cards are only mounted when the panel is expanded. */
const cardCount = () => screen.queryAllByText(/explorer · /).length;

describe("SubAgentsRoundPanel — collapse on settle", () => {
  it("stays expanded while any agent is still running", () => {
    renderPanel([agent("a", "running"), agent("b", "done")], true);
    expect(screen.getByText(/1\/2 running/)).toBeInTheDocument();
    expect(cardCount()).toBe(2);
  });

  it("stays expanded while the TURN is still streaming, even with every agent settled", () => {
    // The regression that caused the reported "scratchy" rendering: `allSettled` flips
    // when the last sub-agent finishes, which is usually mid-turn. Collapsing then
    // unmounted a tall body while the stream was still appending, dropping the document
    // height and jumping everything below it under the auto-scroll.
    renderPanel([agent("a", "done"), agent("b", "done")], true);
    expect(cardCount()).toBe(2);
  });

  it("collapses to the summary line once every agent has settled AND the turn ended", () => {
    renderPanel([agent("a", "done"), agent("b", "done")]);
    // The header still reports the outcome...
    expect(screen.getByText(/2 completed/)).toBeInTheDocument();
    // ...but the reports are no longer in the reader's way.
    expect(cardCount()).toBe(0);
  });

  it("treats an errored agent as settled too", () => {
    renderPanel([agent("a", "done"), agent("b", "error")]);
    expect(cardCount()).toBe(0);
  });

  it("reopens on click and STAYS open — never re-collapses under a reader", () => {
    renderPanel([agent("a", "done"), agent("b", "done")]);
    expect(cardCount()).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: /completed/i }));
    expect(cardCount()).toBe(2);
    // A second render pass (re-render on any parent update) must not fold it back.
    fireEvent.click(screen.getByRole("button", { name: /completed/i }));
    expect(cardCount()).toBe(0);
  });

  it("a live round can be collapsed by hand", () => {
    renderPanel([agent("a", "running")], true);
    expect(cardCount()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /running/i }));
    expect(cardCount()).toBe(0);
  });

  it("an empty round does not claim to be settled", () => {
    // `agents.length > 0` guards this: an empty array must not read as "0 completed"
    // and collapse — there is nothing to collapse, and a round with no agents yet is
    // spinning up, not finished.
    renderPanel([]);
    expect(cardCount()).toBe(0);
    expect(screen.getByText(/0 completed/)).toBeInTheDocument();
  });
});
