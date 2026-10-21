/**
 * An MCP trigger's tool is picked from the server's own tools (QA 15.7.0: it was
 * a free-text box, so a typo saved an automation that could never fire). Free
 * text stays only when the server's tools can't be listed.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "./helpers";

const { listMcpTools, listAccountMcpServers } = vi.hoisted(() => ({
  listMcpTools: vi.fn(async (_id: number) => ({ tools: [{ name: "search_messages" }, { name: "list_channels" }] })),
  listAccountMcpServers: vi.fn(async () => [{ name: "Linear", tools: ["list_issues"] }]),
}));
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => ({ listMcpTools, listAccountMcpServers }) },
}));

import { AutomationForm } from "@/components/automations/AutomationForm";

const servers = [
  { ref: "local:5", name: "Slack", where: "local" as const },
  { ref: "account:Linear", name: "Linear", where: "account" as const },
];

function existing(trigger: Record<string, unknown>) {
  return { id: "a1", name: "Watch", enabled: true, trigger, prompt: "", runMode: "notify-only", notifyAgent: false } as never;
}

describe("the MCP trigger's tool", () => {
  it("is a list of the server's tools, keeping a saved one it no longer lists", async () => {
    renderWithProviders(
      <AutomationForm
        workspaceId={1}
        existing={existing({ kind: "mcp", serverId: 5, tool: "old_tool", args: {}, intervalMinutes: 15 })}
        mcpServers={servers}
        open
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText("Tool name").tagName).toBe("SELECT"));
    expect(listMcpTools).toHaveBeenCalledWith(5);
    const options = [...(screen.getByLabelText("Tool name") as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(["", "old_tool", "list_channels", "search_messages"]);
  });

  it("lists an account server's tools from the account", async () => {
    renderWithProviders(
      <AutomationForm
        workspaceId={1}
        existing={existing({ kind: "mcp", accountServer: "Linear", tool: "list_issues", args: {}, intervalMinutes: 15 })}
        mcpServers={servers}
        open
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText("Tool name").tagName).toBe("SELECT"));
    expect((screen.getByLabelText("Tool name") as HTMLSelectElement).value).toBe("list_issues");
  });

  it("stays free text when the tools can't be listed", async () => {
    listMcpTools.mockRejectedValueOnce(new Error("Connection closed"));
    renderWithProviders(
      <AutomationForm
        workspaceId={1}
        existing={existing({ kind: "mcp", serverId: 5, tool: "x", args: {}, intervalMinutes: 15 })}
        mcpServers={servers}
        open
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    await waitFor(() => expect(listMcpTools).toHaveBeenCalled());
    expect(screen.getByLabelText("Tool name").tagName).toBe("INPUT");
  });
});
