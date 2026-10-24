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
const { setSessionModel } = vi.hoisted(() => ({ setSessionModel: vi.fn(async () => ({})) }));
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => ({ setWorkspaceSessionModel: setSessionModel }) },
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
  setSessionModel.mockClear();
  getDefaultStore().set(activeWorkspaceSessionIdAtom, null);
  getDefaultStore().set(activeSessionModelAtom, null);
});

describe("Effort in the composer menu", () => {
  it("free Auto: no levels, one line saying how to get them", async () => {
    state.cents = 0;
    state.model = { provider: "compass", name: "core-auto" };
    open();
    expect(await screen.findByText(/Free Auto runs at one level/)).toBeTruthy();
    expect(screen.queryByTestId("effort-low")).toBeNull();
  });

  it("paid Auto: low / medium / max, and a choice writes the level", async () => {
    state.cents = 1500;
    state.model = { provider: "compass", name: "core-auto" };
    open();
    expect(await screen.findByTestId("effort-low")).toBeTruthy();
    expect(screen.getByTestId("effort-max")).toBeTruthy();
    fireEvent.click(screen.getByTestId("effort-low"));
    // With the model it belongs to: the app's default is one model + its level.
    expect(state.update).toHaveBeenCalledWith({ selectedModel: state.model, effort: "low", deepThinking: false });
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
    expect(setSessionModel).toHaveBeenCalledWith("sess-a", {
      provider: "openai",
      name: "gpt-5.4",
      effort: "low",
      deepThinking: false,
    });
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
