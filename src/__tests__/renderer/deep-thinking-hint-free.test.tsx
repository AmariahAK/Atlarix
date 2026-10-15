/**
 * On free Auto, deep thinking can't move to stronger models and costs nothing:
 * the hint said "uses stronger models — costs more" on a free account
 * (QA 15.7.1, app batch 3). There it says what it does: thinks longer.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "./helpers";

const { balance } = vi.hoisted(() => ({ balance: { cents: 0 as number | null } }));
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({
    settings: { selectedModel: { provider: "compass", name: "core-auto" } },
    updateSettings: vi.fn(),
  }),
}));
vi.mock("@/hooks/useLanguageModelsByProviders", () => ({
  useLanguageModelsByProviders: () => ({
    data: { compass: [{ apiName: "core-auto", supportsDeepThinking: true }] },
  }),
}));
vi.mock("@/hooks/useTranscriptionProviders", () => ({
  useTranscriptionProviders: () => ({ data: [] }),
}));
vi.mock("@/hooks/useCreditBalance", () => ({
  useCreditBalance: () => ({ balanceCents: balance.cents }),
}));
vi.mock("@/components/DefaultMcpMenuSection", () => ({
  DefaultMcpMenuSection: () => null,
}));

import { ChatConfigDropdown } from "@/components/ChatConfigDropdown";
import { TooltipProvider } from "@/components/ui/tooltip";

function open() {
  renderWithProviders(
    <TooltipProvider>
      <ChatConfigDropdown />
    </TooltipProvider>,
  );
  const btn = screen.getByTestId("chat-config-button");
  fireEvent.pointerDown(btn, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("deep thinking's hint on Auto", () => {
  it("free: thinks longer, no cost", async () => {
    balance.cents = 0;
    open();
    expect(await screen.findByText(/thinks longer/)).toBeTruthy();
    expect(screen.queryByText(/costs more/)).toBeNull();
  });

  it("paid: stronger models, costs more", async () => {
    balance.cents = 1500;
    open();
    expect(await screen.findByText(/costs more/)).toBeTruthy();
  });
});
