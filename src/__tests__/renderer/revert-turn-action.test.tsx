/**
 * v13.1: RevertTurnAction renders only when the turn captured a snapshot, and
 * confirming the dialog calls revertSnapshot with filesOnly.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { turnSnapshotTurnIdByMessageIdAtom } from "@/atoms/chatAtoms";
import { renderWithProviders } from "./helpers";

const getSnapshotFiles = vi.fn(
  async (): Promise<{
    filesChanged: string[];
    createdFiles: string[];
    revertedAt?: string;
  } | null> => ({
    filesChanged: ["src/a.ts"],
    createdFiles: [],
  }),
);
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

  it("says what will be kept from a fresh look when the dialog opens", async () => {
    // Loaded when the reply appeared: nothing changed since yet.
    getSnapshotFiles.mockResolvedValueOnce({ filesChanged: ["a.txt", "b.txt"], createdFiles: [] });
    // By the time the user opens the dialog, b.txt was edited by hand.
    getSnapshotFiles.mockResolvedValueOnce({
      filesChanged: ["a.txt", "b.txt"],
      createdFiles: [],
      kept: ["b.txt"],
    } as never);
    const { store } = renderWithProviders(<div />);
    store.set(turnSnapshotTurnIdByMessageIdAtom, new Map([[MSG_ID, String(MSG_ID)]]));
    renderWithProviders(<RevertTurnAction chatId={CHAT_ID} messageId={MSG_ID} />);
    const btn = await screen.findByTitle("Revert this turn's file changes");
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(await screen.findByText(/Restores 1 file/)).toBeInTheDocument();
    expect(screen.getByText(/Kept b\.txt/)).toBeInTheDocument();
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

    const btn = await screen.findByTitle("Revert this turn's file changes");
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
    // QA #1a: the reply says so, rather than the button just vanishing.
    expect(await screen.findByText("Files reverted")).toBeInTheDocument();
    expect(screen.queryByTitle("Revert this turn's file changes")).toBeNull();
  });

  function withSnapshot() {
    const { store } = renderWithProviders(<div />);
    store.set(
      turnSnapshotTurnIdByMessageIdAtom,
      new Map([[MSG_ID, String(MSG_ID)]]),
    );
  }

  it("QA #1c: a turn reverted before (a reopened chat) shows it, with no Revert", async () => {
    getSnapshotFiles.mockResolvedValueOnce({
      filesChanged: ["src/a.ts"],
      createdFiles: [],
      revertedAt: "2026-10-13T12:00:00.000Z",
    });
    withSnapshot();
    renderWithProviders(
      <RevertTurnAction chatId={CHAT_ID} messageId={MSG_ID} />,
    );
    const marker = await screen.findByText("Files reverted");
    expect(marker).toBeInTheDocument();
    // The action row is hover-only; this attribute keeps it shown (SimpleMessage).
    expect(marker.closest("[data-reverted]")).not.toBeNull();
    expect(screen.queryByTitle("Revert this turn's file changes")).toBeNull();
  });

  it("QA #5: a turn that changed no files offers no Revert", async () => {
    getSnapshotFiles.mockResolvedValueOnce({ filesChanged: [], createdFiles: [] });
    withSnapshot();
    renderWithProviders(
      <RevertTurnAction chatId={CHAT_ID} messageId={MSG_ID} />,
    );
    await waitFor(() => expect(getSnapshotFiles).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTitle("Revert this turn's file changes")).toBeNull();
    expect(screen.queryByText("Files reverted")).toBeNull();
  });
});
