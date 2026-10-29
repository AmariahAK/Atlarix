/**
 * The app's chat list shows where a chat came from (session lineage): a child
 * sits indented right under its parent, says how it came on hover, and an
 * automation's runs listed under a chat are not counted as chats of their own.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";
import { selectedAppIdAtom } from "@/atoms/appAtoms";

const at = (min: number) => new Date(Date.now() - min * 60_000);
// As sessions:list returns them: in tree order, with depth.
const sessions = [
  { id: "lead", title: "Plan the API", depth: 0, parentSessionId: null, origin: { via: "user" }, createdAt: at(90), updatedAt: at(5) },
  { id: "fork", title: "Try GraphQL", depth: 1, parentSessionId: "lead", origin: { via: "fork" }, createdAt: at(20), updatedAt: at(20) },
  {
    id: "run",
    title: "Automation: nightly",
    depth: 1,
    runs: 3,
    parentSessionId: "lead",
    origin: { via: "automation", automationId: "n" },
    createdAt: at(10),
    updatedAt: at(10),
  },
  { id: "other", title: "Fix login", depth: 0, parentSessionId: null, origin: { via: "user" }, createdAt: at(60), updatedAt: at(30) },
];
const fakeIpc = Object.assign(makeFakeIpc(), {
  listWorkspaceSessions: vi.fn(async () => sessions),
});
vi.mock("@/ipc/ipc_client", () => ({ IpcClient: { getInstance: () => fakeIpc } }));
const { loaded } = vi.hoisted(() => ({
  loaded: { apps: [{ id: 41, name: "ws-tree", path: "/w" }], loading: false, error: null, refreshApps: () => {} },
}));
vi.mock("@/hooks/useLoadApps", () => ({ useLoadApps: () => loaded }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

import { AppList } from "@/components/AppList";
import { WorkspaceSessionList } from "@/components/workspace/WorkspaceSessionList";

describe("the app's chat list as a tree", () => {
  it("puts each child under its parent, indented, and says how it came", async () => {
    renderWithProviders(<WorkspaceSessionList workspaceId={41} activeSessionId={null} />);

    const titles = ["Plan the API", "Try GraphQL", "Automation: nightly", "Fix login"];
    const rows = await Promise.all(titles.map((t) => screen.findByText(t)));
    // In the list's order: the children right after their parent.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.compareDocumentPosition(rows[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const rowOf = (el: HTMLElement) => el.closest("div[class*='rounded']") as HTMLElement;
    expect(rowOf(rows[0]!).style.paddingLeft).toBe("");
    expect(rowOf(rows[1]!).style.paddingLeft).toBe("20px");
    expect(rows[1]!.getAttribute("title")).toBe("fork");
    expect(rows[2]!.getAttribute("title")).toBe("automation · 3 runs");
    expect(rows[0]!.getAttribute("title")).toBeNull();
  });

  it("keeps the open chat's whole tree on top", async () => {
    renderWithProviders(<WorkspaceSessionList workspaceId={41} activeSessionId="other" />);
    const [other, lead, fork] = await Promise.all(["Fix login", "Plan the API", "Try GraphQL"].map((t) => screen.findByText(t)));
    expect(other!.compareDocumentPosition(lead!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lead!.compareDocumentPosition(fork!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not count an automation's runs as chats", async () => {
    const { store } = renderWithProviders(<div />);
    store.set(selectedAppIdAtom, 41);
    renderWithProviders(<AppList show />);
    expect(await screen.findByText("3 sessions")).toBeTruthy();
  });
});
