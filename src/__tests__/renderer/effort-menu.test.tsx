/**
 * The composer menu's Effort section (/effort replaced the deep-thinking
 * toggle, 2026-10-17): the model's own levels exactly as listed, paid Auto's
 * low / medium / max, and none on free Auto, which runs at one level.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "./helpers";

const { state } = vi.hoisted(() => ({
  state: {
    cents: 0 as number | null,
    model: { provider: "compass", name: "core-auto" },
    settings: {} as Record<string, unknown>,
    update: null as unknown as ReturnType<typeof vi.fn>,
  },
}));
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ settings: { selectedModel: state.model, ...state.settings }, updateSettings: state.update }),
}));
vi.mock("@/hooks/useLanguageModelsByProviders", () => ({
  useLanguageModelsByProviders: () => ({
    data: {
      compass: [{ apiName: "core-auto", effortChoices: { kind: "effort", levels: ["low", "medium", "max"], defaultLevel: "medium" } }],
      openai: [{ apiName: "gpt-5.4", effortChoices: { kind: "effort", levels: ["none", "low", "medium", "high", "xhigh"], defaultLevel: "medium" } }],
      minimax: [{ apiName: "MiniMax-M2.7" }],
    },
  }),
}));
vi.mock("@/hooks/useTranscriptionProviders", () => ({ useTranscriptionProviders: () => ({ data: [] }) }));
vi.mock("@/hooks/useCreditBalance", () => ({ useCreditBalance: () => ({ balanceCents: state.cents }) }));
vi.mock("@/components/DefaultMcpMenuSection", () => ({ DefaultMcpMenuSection: () => null }));
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => ({ setFrontSession: async () => ({ ok: true }) }) },
}));

import { ChatConfigDropdown } from "@/components/ChatConfigDropdown";
import { getDefaultStore } from "jotai";
import { activeSessionModelAtom, activeWorkspaceSessionIdAtom } from "@/atoms/sessionAtoms";
import { TooltipProvider } from "@/components/ui/tooltip";

function open() {
  renderWithProviders(
    <TooltipProvider>
      <ChatConfigDropdown />
    </TooltipProvider>,
  );
  fireEvent.pointerDown(screen.getByTestId("chat-config-button"), { button: 0, ctrlKey: false, pointerType: "mouse" });
}

beforeEach(() => {
  state.update = vi.fn();
  state.settings = {};
  getDefaultStore().set(activeWorkspaceSessionIdAtom, null);
  getDefaultStore().set(activeSessionModelAtom, null);
});

describe("Effort in the composer menu", () => {
  it("Auto and Zenith offer no effort control, free or paid (owner, 2026-10-29)", async () => {
    for (const [cents, name] of [[0, "core-auto"], [1500, "core-auto"], [1500, "core-zenith"]] as const) {
      state.cents = cents;
      state.model = { provider: "compass", name };
      const { unmount } = renderWithProviders(
        <TooltipProvider>
          <ChatConfigDropdown />
        </TooltipProvider>,
      );
      fireEvent.pointerDown(screen.getByTestId("chat-config-button"), { button: 0, ctrlKey: false, pointerType: "mouse" });
      await screen.findByText(/Effort, voice|MCP/i).catch(() => null);
      expect(screen.queryByTestId("effort-low")).toBeNull();
      expect(screen.queryByText("Effort")).toBeNull();
      unmount();
    }
  });

  it("a model's own levels exactly as listed, xhigh included", async () => {
    state.cents = 0;
    state.model = { provider: "openai", name: "gpt-5.4" };
    open();
    for (const l of ["none", "low", "medium", "high", "xhigh"]) expect(await screen.findByTestId(`effort-${l}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId("effort-xhigh"));
    expect(state.update).toHaveBeenCalledWith({ selectedModel: state.model, effort: "xhigh", deepThinking: true });
  });

  it("a chat on its own model shows that model's levels and its own level, and a pick is that chat's (15.11.1)", async () => {
    state.cents = 0;
    // The app's pick is Auto; this chat runs on GPT-5.4 at "high".
    state.model = { provider: "compass", name: "core-auto" };
    getDefaultStore().set(activeWorkspaceSessionIdAtom, "sess-a");
    getDefaultStore().set(activeSessionModelAtom, { provider: "openai", name: "gpt-5.4", effort: "high" });
    open();
    expect(await screen.findByTestId("effort-xhigh")).toBeTruthy();
    expect(screen.queryByText(/Free Auto runs at one level/)).toBeNull();
    expect(screen.getByTestId("effort-high").getAttribute("data-state")).toBe("checked");
    fireEvent.click(screen.getByTestId("effort-low"));
    // One write: main stores the pair on this window's chat in front as well.
    expect(getDefaultStore().get(activeSessionModelAtom)).toMatchObject({ name: "gpt-5.4", effort: "low" });
    expect(state.update).toHaveBeenCalledWith({
      selectedModel: { provider: "openai", name: "gpt-5.4" },
      effort: "low",
      deepThinking: false,
    });
  });

  it("no section for a model with no control", async () => {
    state.model = { provider: "minimax", name: "MiniMax-M2.7" };
    open();
    await screen.findByTestId("chat-config-button");
    expect(screen.queryByText("Effort")).toBeNull();
  });
});
