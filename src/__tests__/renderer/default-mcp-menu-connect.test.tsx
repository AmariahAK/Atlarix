/**
 * A default that asks for values (a key, a path) is added where those are
 * asked: Connect opens the Marketplace on that server, and the menu closes
 * behind it (QA 15.7.1 #8: it landed on the active tab, with the menu left
 * floating over the Integrations page).
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { renderWithProviders } from "./helpers";

const { navigate, getDefaultMcpServers } = vi.hoisted(() => ({
  navigate: vi.fn(),
  getDefaultMcpServers: vi.fn(async () => [
    {
      name: "io.github.brave/brave-search-mcp-server",
      title: "Brave Search",
      state: "not-added",
      optionId: "npm",
      needsInputs: true,
    },
  ]),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => ({ getDefaultMcpServers }) },
}));
vi.mock("@/components/settings/useMcpAddFlow", () => ({
  useMcpAddFlow: () => ({ finish: vi.fn(), dialog: null }),
}));
vi.mock("@/components/settings/McpServerIcon", () => ({
  McpServerIcon: () => null,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenuLabel: (p: { children: React.ReactNode }) => <div>{p.children}</div>,
}));

import { DefaultMcpMenuSection } from "@/components/DefaultMcpMenuSection";

describe("Connect on a default that asks for values", () => {
  it("opens its Marketplace entry and closes the menu", async () => {
    const { store } = renderWithProviders(<div />);
    store.set(selectedAppIdAtom, 3);
    const onLeave = vi.fn();
    renderWithProviders(<DefaultMcpMenuSection onLeave={onLeave} />);
    await screen.findByText("Brave Search");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /connect/i }));
    });
    expect(navigate).toHaveBeenCalledWith({
      to: "/integrations/mcp",
      search: { tab: "marketplace", q: "Brave Search" },
    });
    expect(onLeave).toHaveBeenCalled();
  });
});
