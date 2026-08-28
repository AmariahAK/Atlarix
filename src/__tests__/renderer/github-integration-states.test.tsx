/**
 * The Integrations section described a button that was not on the screen.
 *
 * `GitHubIntegration` returned `null` when disconnected, while the settings page
 * rendered "GitHub sign-in is saved on this Mac until you disconnect. Use
 * disconnect to connect a different GitHub account." UNDERNEATH it,
 * unconditionally. Reported from the packaged app: the section showed one
 * checkbox and a sentence about a control that did not exist.
 *
 * The sentence was wrong in a second way that would have outlived the missing
 * button — it called this "GitHub sign-in", which is signing in to an Atlarix
 * account WITH GitHub. That is a different credential. You can be signed in that
 * way and hold no `githubAccessToken`, which is precisely the state that produced
 * the report, so the two must never describe each other.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

let mockSettings: Record<string, unknown> = {};

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({
    settings: mockSettings,
    updateSettings: vi.fn(),
    refreshSettings: vi.fn(),
  }),
}));
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => ({ cancelGithubDeviceFlow: vi.fn() }) },
}));
vi.mock("@/lib/toast", () => ({ showSuccess: vi.fn(), showError: vi.fn() }));

import { GitHubIntegration } from "@/components/GitHubIntegration";

describe("GitHubIntegration", () => {
  beforeEach(() => {
    mockSettings = {};
  });

  it("renders a real disconnected state instead of nothing", () => {
    render(<GitHubIntegration />);

    // The regression: returning null is what left the page's help text orphaned.
    expect(screen.getByText(/GitHub Integration/i)).toBeInTheDocument();
    expect(screen.getByText(/Not connected/i)).toBeInTheDocument();
  });

  it("offers no disconnect control when there is nothing to disconnect", () => {
    render(<GitHubIntegration />);

    expect(screen.queryByRole("button", { name: /disconnect/i })).toBeNull();
  });

  it("does not describe this as account sign-in", () => {
    render(<GitHubIntegration />);

    // Signing in to Atlarix WITH GitHub is a different credential, and saying
    // otherwise sent someone looking for a button that belongs to the other one.
    expect(screen.queryByText(/GitHub sign-in is saved/i)).toBeNull();
    expect(screen.getByText(/separate from signing in to your Atlarix account/i))
      .toBeInTheDocument();
  });

  it("shows the disconnect control once a token exists", () => {
    mockSettings = { githubAccessToken: { value: "gho_x", encryptionType: "plaintext" } };
    render(<GitHubIntegration />);

    expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
    expect(screen.getByText(/Connected, and saved on this Mac/i)).toBeInTheDocument();
  });
});
