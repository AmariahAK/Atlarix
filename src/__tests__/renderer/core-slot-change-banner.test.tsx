/**
 * The banner's own behaviour, which is mostly about when it stays away.
 *
 * `core-slot-change-notice.test.ts` covers the DECISION. What is here is the part the
 * component owns: that "say nothing" really renders nothing, that closing it
 * acknowledges so it cannot come back, and that a failing acknowledgement still
 * closes it. The last one matters because the alternative — awaiting IPC before
 * hiding — is a banner that appears stuck when the main side is unhappy.
 */

import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc() as unknown as Record<string, unknown>;
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

import { CoreSlotChangeBanner } from "@/components/chat/CoreSlotChangeBanner";

const SOL = "openai/gpt-5.6-sol";
const ASTRA = "openai/gpt-6-astra";

beforeEach(() => {
  fakeIpc.getCoreSlotChangeNotice = vi.fn(async () => null);
  fakeIpc.ackCoreSlotChange = vi.fn(async () => ({ success: true }));
  fakeIpc.onCoreModelsChanged = vi.fn(() => () => {});
});

const banner = () =>
  document.querySelector('[data-testid="core-slot-change-banner"]');

describe("the Core slot-change banner", () => {
  it("renders nothing when there is no change to report", async () => {
    renderWithProviders(<CoreSlotChangeBanner />);
    // The common case by far — every launch after the first, and every BYOK user.
    await waitFor(() =>
      expect(fakeIpc.getCoreSlotChangeNotice).toHaveBeenCalled(),
    );
    expect(banner()).toBeNull();
  });

  it("names both models, so the user can see which way the cost moved", async () => {
    fakeIpc.getCoreSlotChangeNotice = vi.fn(async () => ({
      from: SOL,
      to: ASTRA,
    }));
    renderWithProviders(<CoreSlotChangeBanner />);

    const el = await screen.findByTestId("core-slot-change-banner");
    // Display-formatted, not raw wire ids — "openai/gpt-6-astra" in a sentence reads
    // like a bug rather than a model.
    expect(el.textContent).toContain("Sol");
    expect(el.textContent).toContain("Astra");
    // And it must point somewhere actionable rather than just announcing a change.
    expect(el.textContent).toMatch(/model selector/i);
  });

  it("acknowledges when dismissed, so it cannot return next launch", async () => {
    fakeIpc.getCoreSlotChangeNotice = vi.fn(async () => ({
      from: SOL,
      to: ASTRA,
    }));
    renderWithProviders(<CoreSlotChangeBanner />);
    await screen.findByTestId("core-slot-change-banner");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Dismiss"));
    });

    expect(banner()).toBeNull();
    // Advancing the baseline IS the dismissal; without this call the notice is
    // in-memory only and comes back forever.
    await waitFor(() => expect(fakeIpc.ackCoreSlotChange).toHaveBeenCalled());
  });

  it("still closes when the acknowledgement fails", async () => {
    fakeIpc.getCoreSlotChangeNotice = vi.fn(async () => ({
      from: SOL,
      to: ASTRA,
    }));
    fakeIpc.ackCoreSlotChange = vi.fn(async () => {
      throw new Error("settings write failed");
    });
    renderWithProviders(<CoreSlotChangeBanner />);
    await screen.findByTestId("core-slot-change-banner");

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Dismiss"));
    });

    // Reappearing next launch is a far smaller failure than a banner that will not
    // close, so the click must not depend on the write succeeding.
    expect(banner()).toBeNull();
  });

  it("does not surface a failed check as an error", async () => {
    fakeIpc.getCoreSlotChangeNotice = vi.fn(async () => {
      throw new Error("main is unhappy");
    });
    renderWithProviders(<CoreSlotChangeBanner />);
    await waitFor(() =>
      expect(fakeIpc.getCoreSlotChangeNotice).toHaveBeenCalled(),
    );
    // A notice is a nicety. It must never be the reason a chat looks broken.
    expect(banner()).toBeNull();
  });

  it("re-checks when the lineup refreshes mid-session", async () => {
    // Overrides refresh hourly in main, so a long-running window can be moved onto
    // another model without ever relaunching — the case this notice exists for.
    let fire: (() => void) | undefined;
    fakeIpc.onCoreModelsChanged = vi.fn((h: () => void) => {
      fire = h;
      return () => {};
    });
    fakeIpc.getCoreSlotChangeNotice = vi.fn(async () => null);
    renderWithProviders(<CoreSlotChangeBanner />);
    await waitFor(() =>
      expect(fakeIpc.getCoreSlotChangeNotice).toHaveBeenCalled(),
    );

    fakeIpc.getCoreSlotChangeNotice = vi.fn(async () => ({
      from: SOL,
      to: ASTRA,
    }));
    fire?.();

    expect(await screen.findByTestId("core-slot-change-banner")).toBeTruthy();
  });
});
