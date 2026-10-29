/**
 * Settings → Plugins: a plugin that runs code is installed only after a second
 * confirm that shows what it runs, and "Not now" on either step installs nothing.
 */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "./helpers";

const preview = {
  stagingId: "abcdef0123456789",
  name: "dbkit",
  version: "1.0.0",
  description: "",
  format: "claude",
  source: "github.com/acme/dbkit",
  sha: "c1c8a8c1471069fb0e188eeaff69b8e8db6564a8",
  skills: ["dbkit:migrate"],
  agents: [],
  commands: [],
  runnables: [
    "hook pre_tool_use Bash: ./check.sh",
    "MCP server db: node server.js (env: DB_URL)",
  ],
  unsupported: [],
  update: null,
};

const { ipc } = vi.hoisted(() => ({
  ipc: {
    listPlugins: vi.fn(async () => []),
    preparePluginInstall: vi.fn(async () => preview),
    commitPluginInstall: vi.fn(async () => ({ name: "dbkit" })),
    discardPluginInstall: vi.fn(async () => {}),
  },
}));
vi.mock("@/ipc/ipc_client", () => ({ IpcClient: { getInstance: () => ipc } }));

import { PluginsSettingsPage } from "@/components/settings/PluginsSettingsPage";

async function startAdd() {
  renderWithProviders(<PluginsSettingsPage />);
  fireEvent.change(screen.getByLabelText("Plugin source"), {
    target: { value: "acme/dbkit" },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
  });
  expect(await screen.findByText("Install dbkit 1.0.0?")).toBeTruthy();
}

beforeEach(() => {
  for (const f of Object.values(ipc)) f.mockClear();
});

describe("installing a plugin that runs code", () => {
  it("shows every runnable at the second confirm, and commits only after it", async () => {
    await startAdd();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    expect(await screen.findByText("dbkit runs code")).toBeTruthy();
    for (const r of preview.runnables) expect(screen.getByText(r)).toBeTruthy();
    expect(ipc.commitPluginInstall).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Install and allow these" }),
      );
    });
    expect(ipc.commitPluginInstall).toHaveBeenCalledWith({
      stagingId: preview.stagingId,
      runnablesConfirmed: true,
    });
  });

  it("installs nothing on Not now, and drops the staged copy", async () => {
    await startAdd();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    });
    expect(ipc.commitPluginInstall).not.toHaveBeenCalled();
    expect(ipc.discardPluginInstall).toHaveBeenCalledWith(preview.stagingId);
  });
});
