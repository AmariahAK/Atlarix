/**
 * 15.11.0 (ai-c8, filming): a reply made in the CLI on Claude Haiku was labelled
 * "Atlarix Auto" in the app, and relabelled when the app's picker changed. A
 * saved reply names the model it ran on, or none; the picker's model only while
 * a reply is still streaming.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();
fakeIpc.getUserSettings = vi.fn(async () => ({ selectedModel: { provider: "openai", name: "picker-model-x" } }));
vi.mock("@/ipc/ipc_client", () => ({ IpcClient: { getInstance: () => fakeIpc } }));

// A working Storage whatever the Node version (Node's own can shadow jsdom's).
const stored = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, String(v)),
    removeItem: (k: string) => void stored.delete(k),
  },
});

import { SimpleMessage } from "@/components/SimpleMessage";
import { buildDisplaySnapshotV1 } from "@/lib/chat/display-snapshot";
import type { Message } from "@/ipc/ipc_types";

const reply = (id: number, displaySnapshot: string | null): Message =>
  ({ id, role: "assistant", content: "Ready.", approvalState: null, commitHash: null, displaySnapshot }) as unknown as Message;

describe("a reply's model label", () => {
  it("a streaming reply shows the picker's model (it has no record yet)", async () => {
    renderWithProviders(<SimpleMessage message={reply(1, null)} isStreaming />);
    await waitFor(() => expect(screen.getByText(/Picker Model X/)).toBeTruthy());
  });

  it("a saved reply with no recorded model shows none, not the picker's", async () => {
    renderWithProviders(
      <>
        <SimpleMessage message={reply(2, null)} />
        <SimpleMessage message={reply(3, null)} isStreaming />
      </>,
    );
    // Settings have loaded once the streaming one names the picker's model.
    await waitFor(() => expect(screen.getAllByText(/Picker Model X/)).toHaveLength(1));
  });

  it("a saved reply names the model it ran on, whatever the picker says", async () => {
    // As the CLI now saves it (session.ts persistReply).
    const snap = JSON.stringify(
      buildDisplaySnapshotV1({ completedThread: [], model: { provider: "bedrock", name: "us.anthropic.claude-haiku-4-5-20251001-v1:0" } }),
    );
    renderWithProviders(<SimpleMessage message={reply(4, snap)} />);
    await waitFor(() => expect(screen.getByText(/haiku/i)).toBeTruthy());
    expect(screen.queryByText(/Picker Model X/)).toBeNull();
  });
});
