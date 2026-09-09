/**
 * v13.1: RevertTurnAction renders only when the turn captured a snapshot, and
 * confirming the dialog calls revertSnapshot with filesOnly.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { turnSnapshotTurnIdByMessageIdAtom } from "@/atoms/chatAtoms";
import { renderWithProviders } from "./helpers";

const getSnapshotFiles = vi.fn(async () => ({
  filesChanged: ["src/a.ts"],
  createdFiles: [],
}));
const revertSnapshot = vi.fn(async () => ({ success: true, restoredFiles: 1 }));

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => ({ getSnapshotFiles, revertSnapshot }) },
}));
vi.mock("@/lib/toast", () => ({
  showSuccess: vi.fn(),
  showError: vi.fn(),
}));

import { RevertTurnAction } from "@/components/chat/RevertTurnAction";

const CHAT_ID = 5;
const MSG_ID = 1001;

describe("RevertTurnAction", () => {
  beforeEach(() => {
    getSnapshotFiles.mockClear();
    revertSnapshot.mockClear();
    const { store } = renderWithProviders(<div />);
    store.set(turnSnapshotTurnIdByMessageIdAtom, new Map());
  });

  it("renders nothing when the turn has no snapshot", () => {
    renderWithProviders(
      <RevertTurnAction chatId={CHAT_ID} messageId={MSG_ID} />,
    );
    expect(screen.queryByTitle("Revert this turn's file changes")).toBeNull();
  });

  it("shows the action and reverts (filesOnly) on confirm when a snapshot exists", async () => {
    const { store } = renderWithProviders(<div />);
    store.set(
      turnSnapshotTurnIdByMessageIdAtom,
      new Map([[MSG_ID, String(MSG_ID)]]),
    );
    renderWithProviders(
      <RevertTurnAction chatId={CHAT_ID} messageId={MSG_ID} />,
    );

    const btn = screen.getByTitle("Revert this turn's file changes");
    expect(btn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(btn);
    });
    expect(getSnapshotFiles).toHaveBeenCalledWith({
      chatId: CHAT_ID,
      turnId: String(MSG_ID),
    });

    const confirm = await screen.findByText("Revert files");
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() =>
      expect(revertSnapshot).toHaveBeenCalledWith(CHAT_ID, String(MSG_ID), {
        filesOnly: true,
      }),
    );
  });
});
