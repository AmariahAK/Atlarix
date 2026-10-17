/**
 * The composer's config button is an icon: without a name a screen reader
 * announced it as "button" (app QA, 2026-10-14). Its name says what the menu
 * holds, as its tooltip does.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./helpers";

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ settings: {}, updateSettings: vi.fn() }),
}));
vi.mock("@/hooks/useLanguageModelsByProviders", () => ({
  useLanguageModelsByProviders: () => ({ data: {} }),
}));
vi.mock("@/hooks/useTranscriptionProviders", () => ({
  useTranscriptionProviders: () => ({ data: [] }),
}));
vi.mock("@/components/DefaultMcpMenuSection", () => ({
  DefaultMcpMenuSection: () => null,
}));

import { ChatConfigDropdown } from "@/components/ChatConfigDropdown";
import { TooltipProvider } from "@/components/ui/tooltip";

describe("the composer's config button", () => {
  it("has a name", () => {
    renderWithProviders(
      <TooltipProvider>
        <ChatConfigDropdown />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("chat-config-button").getAttribute("aria-label")).toBe(
      "Effort, voice & MCP servers",
    );
    expect(screen.getByRole("button", { name: "Effort, voice & MCP servers" })).toBeTruthy();
  });
});
