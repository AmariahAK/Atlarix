/**
 * QA (app) #17: the plan card in the chat had no Build button — the model said
 * "Switch to Build and I'll implement it", and Build only existed in the
 * collapsed right panel. The card has always had the button; nothing passed it
 * a handler. Its draft state also read "TBD"; the CLI says "ready to build".
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const PLAN_ID = "787bb61d-51c9-4476-9370-ee0d7a6a7832";
const fakeIpc = Object.assign(makeFakeIpc(), {
  getPlanArtifact: vi.fn(async () => ({
    planId: PLAN_ID,
    sessionId: "s1",
    content: "Add a CLI.\n\n1. [ ] Add `bin/tally.js`",
    planStatus: "plan",
    title: "Add a CLI",
  })),
  onPlanArtifactUpdated: vi.fn(() => () => {}),
});
vi.mock("@/contexts/ThemeContext", () => ({
  useTheme: () => ({ theme: "light", isDarkMode: false, setTheme: () => {} }),
}));
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

import { SimpleMessage } from "@/components/SimpleMessage";
import type { Message } from "@/ipc/ipc_types";

describe("the plan card in the chat", () => {
  it("has a Build button wired to the chat, and a draft reads 'Ready to build'", async () => {
    const onBuild = vi.fn();
    renderWithProviders(
      <SimpleMessage
        message={{ id: 9, role: "assistant", content: `Here is the plan.\n<!-- atlarix-plan-artifact:${PLAN_ID} -->` } as unknown as Message}
        chatId={7}
        onPlanArtifactBuild={onBuild}
      />,
    );
    // The card opens like any artifact card; Build is inside.
    await act(async () => fireEvent.click(await screen.findByText("Add a CLI")));
    const build = await screen.findByRole("button", { name: /^Build/ });
    expect(screen.getByText("Ready to build")).toBeTruthy();
    await act(async () => fireEvent.click(build));
    expect(onBuild).toHaveBeenCalledWith(PLAN_ID);
  });
});
