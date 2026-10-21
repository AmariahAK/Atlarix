/**
 * The composer menu's MCP switches (15.7.0 app QA): turning one took 3-5 s with
 * no pending state, and a second click was lost. The switch now moves at once
 * and is disabled while its change saves; a second server flipped meanwhile
 * saves too; and the change re-reads only the lists it affects, not every
 * server's tools (which reconnects them all).
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { renderWithProviders } from "./helpers";

const { gates, updateMcpServer, setAccountMcpEnabled, getDefaultMcpServers } = vi.hoisted(() => {
  const gates: Array<() => void> = [];
  const pending = () => new Promise<void>((resolve) => gates.push(resolve));
  return {
    gates,
    updateMcpServer: vi.fn(pending),
    setAccountMcpEnabled: vi.fn(pending),
    getDefaultMcpServers: vi.fn(async () => [
      { name: "sentry", title: "Sentry", state: "on", where: "local", id: 1 },
      { name: "linear", title: "Linear", state: "off", where: "account", id: "acc-2" },
    ]),
  };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => ({ getDefaultMcpServers, updateMcpServer, setAccountMcpEnabled }) },
}));
vi.mock("@/components/settings/useMcpAddFlow", () => ({
  useMcpAddFlow: () => ({ finish: vi.fn(), dialog: null }),
}));
vi.mock("@/components/settings/McpServerIcon", () => ({ McpServerIcon: () => null }));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenuLabel: (p: { children: React.ReactNode }) => <div>{p.children}</div>,
}));

import { DefaultMcpMenuSection } from "@/components/DefaultMcpMenuSection";

describe("composer MCP switches", () => {
  it("move at once, wait while saving, and a second one isn't lost", async () => {
    getDefaultStore().set(selectedAppIdAtom, 3);
    const { queryClient } = renderWithProviders(<DefaultMcpMenuSection />);
    await screen.findByText("Sentry");
    const sentry = () => screen.getByRole("switch", { name: "Sentry on" });
    const linear = () => screen.getByRole("switch", { name: "Linear on" });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => fireEvent.click(sentry()));
    expect(sentry().getAttribute("aria-checked")).toBe("false");
    expect(sentry().hasAttribute("disabled")).toBe(true);

    await act(async () => fireEvent.click(linear()));
    expect(linear().getAttribute("aria-checked")).toBe("true");
    expect(updateMcpServer).toHaveBeenCalledWith({ id: 1, enabled: false });
    expect(setAccountMcpEnabled).toHaveBeenCalledWith({ id: "acc-2", enabled: true, appId: 3 });
    // The first one is still saving after the second started.
    expect(sentry().hasAttribute("disabled")).toBe(true);

    await act(async () => gates.forEach((g) => g()));
    expect(sentry().hasAttribute("disabled")).toBe(false);
    const keys = invalidate.mock.calls.map(([f]) => JSON.stringify(f?.queryKey));
    expect(keys).not.toContain(JSON.stringify(["mcp"]));
  });
});
