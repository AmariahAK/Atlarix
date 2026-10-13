/**
 * QA (app) #11: the workspace header said "1 session" with two listed. The
 * count was read once when the workspace opened (never on a new session), and
 * from the list's newest ten, so it also stopped at 10.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { act, screen } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { workspaceSessionsRefreshAtom } from "@/atoms/sessionAtoms";

let sessions = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, title: `Session ${i}`, createdAt: new Date() }));
const fakeIpc = Object.assign(makeFakeIpc(), {
  listWorkspaceSessions: vi.fn(async () => sessions),
});
vi.mock("@/ipc/ipc_client", () => ({ IpcClient: { getInstance: () => fakeIpc } }));
// Stable, as the real hook's are: a new array per render re-runs the load.
const { loaded } = vi.hoisted(() => ({
  loaded: { apps: [{ id: 39, name: "ws-app", path: "/w" }], loading: false, error: null, refreshApps: () => {} },
}));
vi.mock("@/hooks/useLoadApps", () => ({ useLoadApps: () => loaded }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

import { AppList } from "@/components/AppList";

describe("the workspace header's session count", () => {
  it("counts every session, and follows a new one", async () => {
    const { store } = renderWithProviders(<div />);
    store.set(selectedAppIdAtom, 39);
    renderWithProviders(<AppList show />);
    expect(await screen.findByText("12 sessions")).toBeTruthy();
    sessions = [...sessions, { id: "s12", title: "New", createdAt: new Date() }];
    await act(async () => store.set(workspaceSessionsRefreshAtom, (n) => n + 1));
    expect(await screen.findByText("13 sessions")).toBeTruthy();
  });
});
