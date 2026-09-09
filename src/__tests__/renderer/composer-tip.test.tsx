/**
 * The tip's ELIGIBILITY gates, which live in the component rather than the policy.
 *
 * `composer-tips.test.ts` covers which tip and whether to show one at all. These four
 * conditions are the component's own, and each is the difference between a helpful line
 * and an interruption: a tip under a half-typed message, a tip competing with streaming
 * output, or a tip about ⌘J sitting under a sign-in prompt.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { makeFakeIpc, renderWithProviders } from "./helpers";

const fakeIpc = makeFakeIpc();
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

import { ComposerTip } from "@/components/chat/ComposerTip";

/** `showProbability` is per-key, so some chat ids draw a blank. Find one that shows. */
function chatIdThatShowsATip(): number {
  getDefaultStore().set(selectedAppIdAtom, 1);
  for (let id = 1; id < 200; id++) {
    const { container, unmount } = renderWithProviders(
      <ComposerTip
        chatId={id}
        composerIsEmpty={true}
        isStreaming={false}
        mustSignIn={false}
      />,
    );
    const shown = container.querySelector('[data-testid="composer-tip"]') !== null;
    unmount();
    if (shown) return id;
  }
  throw new Error("no chat id produced a tip — the pool or the probability is broken");
}

describe("ComposerTip eligibility", () => {
  const CHAT_ID = chatIdThatShowsATip();

  const render = (props: Partial<React.ComponentProps<typeof ComposerTip>>) =>
    renderWithProviders(
      <ComposerTip
        chatId={CHAT_ID}
        composerIsEmpty={true}
        isStreaming={false}
        mustSignIn={false}
        {...props}
      />,
    );

  it("shows on an empty composer with no turn running", () => {
    render({});
    expect(screen.getByTestId("composer-tip")).toBeTruthy();
  });

  it("hides once there is text in the composer", () => {
    const { container } = render({ composerIsEmpty: false });
    expect(container.querySelector('[data-testid="composer-tip"]')).toBeNull();
  });

  it("hides while a turn is streaming", () => {
    const { container } = render({ isStreaming: true });
    expect(container.querySelector('[data-testid="composer-tip"]')).toBeNull();
  });

  it("hides when the user must sign in", () => {
    // That slot already holds SignInToChatNotice, and a shortcut tip under a sign-in
    // prompt is noise rather than help.
    const { container } = render({ mustSignIn: true });
    expect(container.querySelector('[data-testid="composer-tip"]')).toBeNull();
  });

  it("does not change on re-render — the reason it is not on a timer", () => {
    const first = render({});
    const text = screen.getByTestId("composer-tip").textContent;
    first.unmount();
    for (let i = 0; i < 5; i++) {
      const again = render({});
      expect(screen.getByTestId("composer-tip").textContent).toBe(text);
      again.unmount();
    }
  });
});
