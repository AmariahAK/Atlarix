/**
 * ATLARIX-45, the renderer half: opening a Recent workspace whose folder is gone
 * says so plainly and offers to remove it, instead of the raw IPC error.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { toastError, showError, importApp } = vi.hoisted(() => ({
  toastError: vi.fn(),
  showError: vi.fn(),
  importApp: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toast: { error: toastError }, showError }));
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => ({ importApp }) },
}));

import { openWorkspaceFolder } from "@/lib/open-workspace-session";

/** What Electron hands the renderer when a handler throws. */
const ipcError = (message: string) =>
  new Error(`Error invoking remote method 'import-app': Error: ${message}`);

describe("opening a workspace whose folder is gone", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      electron: { ipcRenderer: { invoke: async () => ({ user: { id: "u" } }) } },
    });
    toastError.mockClear();
    showError.mockClear();
  });

  it("shows the plain message and offers Remove…, which the caller confirms", async () => {
    importApp.mockRejectedValueOnce(
      ipcError("[expected:folder-missing] This folder no longer exists."),
    );
    const onFolderMissing = vi.fn();
    expect(
      await openWorkspaceFolder({ folderPath: "/gone/proj", onFolderMissing }),
    ).toBeNull();
    expect(showError).not.toHaveBeenCalled();
    const [message, opts] = toastError.mock.calls[0];
    expect(message).toBe("This folder no longer exists.");
    expect(opts.description).toBe("/gone/proj");
    opts.action.onClick();
    expect(onFolderMissing).toHaveBeenCalledTimes(1);
  });

  it("shows no action when the caller has nothing to remove", async () => {
    importApp.mockRejectedValueOnce(
      ipcError("[expected:folder-missing] This folder no longer exists."),
    );
    await openWorkspaceFolder({ folderPath: "/gone/proj" });
    expect(toastError.mock.calls[0][1].action).toBeUndefined();
  });

  it("any other failure is still a full error", async () => {
    importApp.mockRejectedValueOnce(ipcError("[import-app] Error: disk on fire"));
    await openWorkspaceFolder({ folderPath: "/x" });
    expect(toastError).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
  });
});
