/**
 * The app's mod layer: status chips, panes drawn from the mod's tree, and a
 * button's action sent back to the mod before the pane is drawn again.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "./helpers";

const { ipc, emit } = vi.hoisted(() => {
  let listener: ((e: unknown) => void) | null = null;
  let n = 0;
  return {
    emit: (e: unknown) => listener?.(e),
    ipc: {
      onModUi: vi.fn((l: (e: unknown) => void) => {
        listener = l;
        return () => {};
      }),
      openModPanes: vi.fn(async () => []),
      renderModPane: vi.fn(async () => ({
        type: "Box",
        children: [
          { type: "Text", props: { text: `count ${n}` } },
          { type: "Button", props: { text: "Add", action: "add" } },
        ],
      })),
      modAction: vi.fn(async () => {
        n += 1;
      }),
    },
  };
});
vi.mock("@/ipc/ipc_client", () => ({ IpcClient: { getInstance: () => ipc } }));

import { ModUiLayer } from "@/components/mods/ModUiLayer";

describe("ModUiLayer", () => {
  it("shows status, opens a pane, and redraws it after a button", async () => {
    renderWithProviders(<ModUiLayer />);
    await act(async () => {
      emit({ kind: "status", plugin: "counter", text: "3 todos" });
      emit({ kind: "open", plugin: "counter", id: "main", title: "Counter" });
    });
    expect(await screen.findByText("3 todos")).toBeTruthy();
    expect(await screen.findByText("count 0")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }));
    });
    expect(ipc.modAction).toHaveBeenCalledWith("counter", "add", null, "main");
    expect(await screen.findByText("count 1")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close Counter" }));
    });
    expect(screen.queryByText("count 1")).toBeNull();
  });

  it("draws an open pane again when the mod asks for a redraw (A9)", async () => {
    renderWithProviders(<ModUiLayer />);
    await act(async () => {
      emit({ kind: "open", plugin: "counter", id: "main", title: "Counter" });
    });
    const shown = await screen.findByText(/^count \d+$/);
    const n = Number(shown.textContent!.split(" ")[1]);
    await ipc.modAction("counter", "add", null);
    await act(async () => {
      emit({ kind: "redraw", plugin: "counter" });
    });
    expect(await screen.findByText(`count ${n + 1}`)).toBeTruthy();
  });
});
