/**
 * Picking a workspace in ⌘K opens it the way the welcome screen's recents do:
 * its own session and chat. Setting only the selection moved the header and
 * sidebar while the composer and chat stayed on the previous workspace, so the
 * next message ran there; a workspace never opened in the app hung on
 * "Loading workspace…" (QA 15.7.1 #6, #6b).
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { renderWithProviders } from "./helpers";

let pick: ((id: number) => void) | null = null;
vi.mock("@/components/AppSearchDialog", () => ({
  AppSearchDialog: (p: { onSelectApp: (id: number) => void }) => {
    pick = p.onSelectApp;
    return null;
  },
}));
const { openWorkspaceByAppId } = vi.hoisted(() => ({
  openWorkspaceByAppId: vi.fn(async () => null),
}));
vi.mock("@/lib/open-workspace-session", () => ({ openWorkspaceByAppId }));
vi.mock("@/hooks/useLoadApps", () => ({
  useLoadApps: () => ({
    apps: [{ id: 2, name: "ws1", path: "/tmp/ws1", createdAt: new Date(0) }],
    refreshApps: vi.fn(),
  }),
}));
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

import { GlobalAppSearch } from "@/components/GlobalAppSearch";

describe("⌘K workspace switch", () => {
  it("opens the picked workspace's own session and chat", async () => {
    renderWithProviders(<GlobalAppSearch />);
    await act(async () => {
      pick!(2);
    });
    expect(openWorkspaceByAppId).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 2 }),
    );
  });
});
