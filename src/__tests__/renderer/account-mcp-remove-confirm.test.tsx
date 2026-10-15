/**
 * Removing a server that's on the account takes it off every device, so the
 * app asks first, as the website does (QA 15.7.1 #14: one click removed it).
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "./helpers";

const { removeAccountMcp } = vi.hoisted(() => ({
  removeAccountMcp: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: {
    getInstance: () => ({
      listAccountMcpServers: async () => [
        { id: "c1", name: "deepwiki", url: "https://mcp.deepwiki.com/mcp", authType: "none", connected: true, enabled: true, tools: [], registryName: null, authHeader: null, lastError: null },
      ],
      removeAccountMcp,
    }),
  },
}));
vi.mock("@/components/settings/McpServerIcon", () => ({ McpServerIcon: () => null }));
vi.mock("@/components/settings/useMcpAddFlow", () => ({
  useMcpAddFlow: () => ({ finish: vi.fn(), dialog: null }),
}));

import { AccountMcpSection } from "@/components/settings/AccountMcpSection";

describe("Remove on an account server", () => {
  it("asks first, and removes only on yes", async () => {
    renderWithProviders(<AccountMcpSection appId={1} />);
    await screen.findByText("deepwiki");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    expect(removeAccountMcp).not.toHaveBeenCalled();
    expect(await screen.findByText("Remove deepwiki?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    });
    expect(removeAccountMcp).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    const dialog = await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(
        [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Remove")!,
      );
    });
    expect(removeAccountMcp).toHaveBeenCalledWith("c1");
  });
});
