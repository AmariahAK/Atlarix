/**
 * v14.8.10 — the background-jobs popover shows a stall/matched badge and, on
 * expand, polls + renders the job's live output tail (so users can watch a
 * background command and then discuss it).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { backgroundJobsByChatIdAtom } from "@/atoms/sourceAtoms";
import { attachmentsAtom } from "@/atoms/chatAtoms";
import { renderWithProviders } from "./helpers";

const backgroundJobOutput = vi.fn(async () => ({
  command: "npm run dev",
  output: "compiled successfully in 1.2s",
  elapsedMs: 3000,
}));
const backgroundJobCancel = vi.fn(async () => ({ ok: true }));

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: {
    getInstance: () => ({ backgroundJobOutput, backgroundJobCancel }),
  },
}));

import { BackgroundJobsIndicator } from "@/components/chat/BackgroundJobsIndicator";

const CHAT_ID = 77;

describe("BackgroundJobsIndicator (live view)", () => {
  beforeEach(() => {
    backgroundJobOutput.mockClear();
    const store = getDefaultStore();
    store.set(attachmentsAtom, []);
    store.set(backgroundJobsByChatIdAtom, {
      [CHAT_ID]: [
        {
          operationId: "op-1",
          command: "npm run dev",
          startedAt: 1,
          elapsedMs: 5000,
          stalled: true,
        },
      ],
    });
  });

  it("opens the popover, shows a stalled badge, and streams live output on expand", async () => {
    renderWithProviders(<BackgroundJobsIndicator chatId={CHAT_ID} />);

    // Open the popover.
    fireEvent.click(screen.getByText(/1 background task running/i));
    expect(await screen.findByText("npm run dev")).toBeTruthy();
    expect(screen.getByText(/stalled/i)).toBeTruthy();

    // Expand the row → pulls + shows the live output tail.
    fireEvent.click(screen.getByLabelText("Show live output"));
    await waitFor(() => {
      expect(backgroundJobOutput).toHaveBeenCalledWith(CHAT_ID, "op-1");
      expect(screen.getByText(/compiled successfully in 1\.2s/)).toBeTruthy();
    });
  });

  it("renders a 'matched' badge when the wake condition fired", async () => {
    act(() => {
      getDefaultStore().set(backgroundJobsByChatIdAtom, {
        [CHAT_ID]: [
          {
            operationId: "op-2",
            command: "tail -f app.log",
            startedAt: 1,
            elapsedMs: 5000,
            wakeMatched: true,
          },
        ],
      });
    });
    renderWithProviders(<BackgroundJobsIndicator chatId={CHAT_ID} />);
    fireEvent.click(screen.getByText(/1 background task running/i));
    expect(await screen.findByText(/matched/i)).toBeTruthy();
  });
});
