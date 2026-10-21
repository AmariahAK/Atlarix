/**
 * The app's MCP list follows a change the CLI made to the same profile once the
 * window gets focus back (15.7.0 app QA: only a tab switch showed it).
 * react-query re-reads on `visibilitychange` only, and a window that stays
 * visible behind the terminal never fires it.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "./helpers";

const { listMcpServers } = vi.hoisted(() => ({
  listMcpServers: vi.fn(async () => [] as Array<{ id: number; name: string }>),
}));
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => ({ listMcpServers, listMcpTools: vi.fn(async () => ({ tools: [] })) }) },
}));

import { useMcp } from "@/hooks/useMcp";

function Names() {
  const { servers } = useMcp() as unknown as { servers: Array<{ name: string }> };
  return <div>{(servers ?? []).map((s) => s.name).join(",") || "none"}</div>;
}

describe("the MCP server list", () => {
  it("is read again when the window gets focus back", async () => {
    renderWithProviders(<Names />);
    await screen.findByText("none");
    listMcpServers.mockResolvedValue([{ id: 1, name: "Added in the CLI" }]);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(screen.getByText("Added in the CLI")).toBeTruthy());
  });
});
