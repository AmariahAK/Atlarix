/**
 * The reported bug: a reviewer pasted a public repo URL, named the workspace, and the
 * Clone button was disabled with nothing saying why — they concluded it required a
 * GitHub account and stopped testing.
 *
 * These tests pin the fix: the button always states why it is unavailable, a destination
 * can be TYPED (not only picked), and a picker that fails to open says so instead of
 * doing nothing.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "./helpers";

const { validateParentDirMock, cloneRepoFromUrlMock, showErrorMock } = vi.hoisted(
  () => ({
    validateParentDirMock: vi.fn(),
    cloneRepoFromUrlMock: vi.fn(),
    showErrorMock: vi.fn(),
  }),
);

const fakeIpc = {
  validateParentDir: validateParentDirMock,
  cloneRepoFromUrl: cloneRepoFromUrlMock,
  listGithubRepos: vi.fn(async () => []),
  cancelGithubClone: vi.fn(),
  cancelGithubDeviceFlow: vi.fn(),
  onGithubCloneProgress: vi.fn(() => () => {}),
  onGithubDeviceFlowSuccess: vi.fn(() => () => {}),
};

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

vi.mock("@/lib/toast", () => ({
  showError: showErrorMock,
  showSuccess: vi.fn(),
  showWarning: vi.fn(),
  showInfo: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ settings: {}, refreshSettings: vi.fn() }),
}));

vi.mock("@/hooks/useLoadApps", () => ({
  useLoadApps: () => ({ apps: [], loading: false, refreshApps: vi.fn() }),
}));

vi.mock("@/lib/open-workspace-session", () => ({
  openWorkspaceByAppId: vi.fn(async () => undefined),
}));

// Heavy, settings-dependent subtrees the URL tab never renders.
vi.mock("@/components/GitHubConnector", () => ({
  UnconnectedGitHubConnector: () => <div>connect github</div>,
}));
vi.mock("@/components/GitHubIntegration", () => ({
  GitHubIntegration: () => <div>github integration</div>,
}));

import { WelcomeCloneDialog } from "@/components/welcome/WelcomeCloneDialog";

const invokeMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  validateParentDirMock.mockImplementation(async (p: string) => ({
    ok: true,
    path: p.trim(),
  }));
  (window as unknown as { electron: unknown }).electron = {
    ipcRenderer: { invoke: invokeMock },
  };
});

function renderDialog() {
  return renderWithProviders(
    <WelcomeCloneDialog open onOpenChange={vi.fn()} />,
  );
}

const cloneButton = () => screen.getByRole("button", { name: "Clone" });

describe("clone dialog — disabled state explains itself", () => {
  it("asks for a URL first, with Clone disabled", () => {
    renderDialog();
    expect(cloneButton()).toBeDisabled();
    expect(screen.getByText(/Paste a repository URL to continue/i)).toBeTruthy();
  });

  it("names the missing destination once a URL is entered", () => {
    renderDialog();
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/github.com\/org\/repo/i), {
      target: { value: "https://github.com/mementobuilds/tap-flash-poc" },
    });
    expect(cloneButton()).toBeDisabled();
    expect(
      screen.getByText(/Choose where to save this repository to continue/i),
    ).toBeTruthy();
  });
});

describe("clone dialog — a destination can be typed", () => {
  it("enables Clone and shows the resolved destination path", async () => {
    renderDialog();
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/github.com\/org\/repo/i), {
      target: { value: "https://github.com/mementobuilds/tap-flash-poc" },
    });
    fireEvent.change(screen.getByLabelText("Save to"), {
      target: { value: "/Users/me/code" },
    });

    await waitFor(() => expect(cloneButton()).toBeEnabled(), { timeout: 3000 });
    expect(validateParentDirMock).toHaveBeenCalledWith("/Users/me/code");
    expect(screen.getByText("/Users/me/code/tap-flash-poc")).toBeTruthy();
  });

  it("keeps Clone disabled and shows the reason when the folder is rejected", async () => {
    validateParentDirMock.mockResolvedValue({
      ok: false,
      error: "That folder is not writable: /root",
    });
    renderDialog();
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/github.com\/org\/repo/i), {
      target: { value: "https://github.com/org/repo.git" },
    });
    fireEvent.change(screen.getByLabelText("Save to"), {
      target: { value: "/root" },
    });

    await waitFor(
      () => expect(screen.getByText(/not writable: \/root/i)).toBeTruthy(),
      { timeout: 3000 },
    );
    expect(cloneButton()).toBeDisabled();
  });

  it("clones with the typed destination joined to the workspace name", async () => {
    cloneRepoFromUrlMock.mockResolvedValue({
      app: { id: 1, name: "tap flash", path: "/Users/me/code/tap flash" },
    });
    renderDialog();
    fireEvent.change(screen.getByPlaceholderText(/https:\/\/github.com\/org\/repo/i), {
      target: { value: "https://github.com/mementobuilds/tap-flash-poc" },
    });
    fireEvent.change(screen.getByPlaceholderText("Workspace name"), {
      target: { value: "tap flash" },
    });
    fireEvent.change(screen.getByLabelText("Save to"), {
      target: { value: "/Users/me/code" },
    });
    await waitFor(() => expect(cloneButton()).toBeEnabled(), { timeout: 3000 });

    fireEvent.click(cloneButton());

    await waitFor(() =>
      expect(cloneRepoFromUrlMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://github.com/mementobuilds/tap-flash-poc",
          appName: "tap flash",
          targetPath: "/Users/me/code/tap flash",
        }),
      ),
    );
  });
});

describe("clone dialog — folder picker failures are visible", () => {
  it("reports a picker that cannot open", async () => {
    invokeMock.mockRejectedValue(new Error("no portal"));
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /Choose folder/i }));

    await waitFor(() =>
      expect(showErrorMock).toHaveBeenCalledWith(
        expect.stringMatching(/type the folder path instead/i),
      ),
    );
  });

  it("stays silent when the user cancels the picker", async () => {
    invokeMock.mockResolvedValue({ canceled: true, filePaths: [] });
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /Choose folder/i }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(showErrorMock).not.toHaveBeenCalled();
  });

  it("fills the destination field from a successful pick", async () => {
    invokeMock.mockResolvedValue({ canceled: false, filePaths: ["/Users/me/picked"] });
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: /Choose folder/i }));

    await waitFor(() =>
      expect(screen.getByLabelText("Save to")).toHaveValue("/Users/me/picked"),
    );
  });
});
