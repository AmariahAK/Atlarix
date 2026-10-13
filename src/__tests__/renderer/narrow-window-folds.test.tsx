/**
 * QA (app) #20 + #48: at 960px, opening the right panel folds the session
 * sidebar; closing the panel brings it back (it used to stay folded until
 * Toggle Sidebar). A sidebar the user closed is left closed.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";

vi.mock("@/ipc/ipc_client", () => ({ IpcClient: { getInstance: () => ({}) } }));
const { NarrowWindowFolds } = await import("@/app/layout");

function Probe() {
  const { open } = useSidebar();
  return <span data-testid="sidebar">{open ? "open" : "folded"}</span>;
}

function ui(panel: boolean) {
  return (
    <SidebarProvider>
      <NarrowWindowFolds rightPanelVisible={panel} />
      <Probe />
    </SidebarProvider>
  );
}

describe("a narrow window with the right panel", () => {
  it("folds the sidebar when the panel opens, and unfolds it when it closes", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 960 });
    const { getByTestId, rerender } = render(ui(false));
    expect(getByTestId("sidebar").textContent).toBe("open");
    rerender(ui(true));
    expect(getByTestId("sidebar").textContent).toBe("folded");
    rerender(ui(false));
    expect(getByTestId("sidebar").textContent).toBe("open");
  });
});
