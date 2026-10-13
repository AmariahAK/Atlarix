/**
 * QA (app) #49: a reply's header named the CURRENT model, so after switching
 * to Atlarix Auto a turn Glm 5.3 had answered read "Atlarix Auto". The turn's
 * model is saved with its reply and the header names that.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();
vi.mock("@/ipc/ipc_client", () => ({ IpcClient: { getInstance: () => fakeIpc } }));
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ settings: { selectedModel: { provider: "compass", name: "core-auto" } }, updateSettings: vi.fn() }),
}));

import { SimpleMessage } from "@/components/SimpleMessage";
import type { Message } from "@/ipc/ipc_types";

describe("a reply's header", () => {
  it("names the model the reply ran on, not the one selected now", () => {
    const snapshot = JSON.stringify({
      version: 1,
      completedThread: [],
      interleavedContent: "Done.",
      model: { provider: "zhipu", name: "glm-5.3" },
    });
    renderWithProviders(
      <SimpleMessage
        message={{ id: 70, role: "assistant", content: "Done.", displaySnapshot: snapshot } as unknown as Message}
        chatId={7}
      />,
    );
    expect(screen.getByText(/Glm 5\.3/i)).toBeTruthy();
  });
});
