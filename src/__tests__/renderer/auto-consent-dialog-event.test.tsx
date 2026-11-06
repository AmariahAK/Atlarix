/**
 * The app's free Auto consent dialog sends auto_consent: shown when it opens,
 * then ONE answer per opening ("Not now" also closes the dialog, which used to
 * be a second cancel), with what opened it.
 */
import React, { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const capture = vi.fn();
vi.mock("posthog-js/react", () => ({ usePostHog: () => ({ capture }) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { AtlarixAutoConsentDialog } from "@/components/AtlarixAutoConsentDialog";

function Harness({ onAccept = () => {} }: { onAccept?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>ask</button>
      <AtlarixAutoConsentDialog
        open={open}
        trigger="picker"
        onAccept={() => {
          setOpen(false);
          onAccept();
        }}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

const sent = () => capture.mock.calls.map(([e, p]) => [e, p.action, p.trigger, p.surface]);

beforeEach(() => capture.mockClear());

describe("auto_consent from the app", () => {
  it("shown, then declined once for Not now", async () => {
    render(<Harness />);
    await act(async () => fireEvent.click(screen.getByText("ask")));
    await act(async () => fireEvent.click(screen.getByText("atlarixAuto.consentCancel")));
    expect(sent()).toEqual([
      ["auto_consent", "shown", "picker", "app"],
      ["auto_consent", "declined", "picker", "app"],
    ]);
  });

  it("shown, then accepted; a second opening counts again", async () => {
    render(<Harness />);
    await act(async () => fireEvent.click(screen.getByText("ask")));
    await act(async () => fireEvent.click(screen.getByText("atlarixAuto.consentAccept")));
    await act(async () => fireEvent.click(screen.getByText("ask")));
    await act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    expect(sent()).toEqual([
      ["auto_consent", "shown", "picker", "app"],
      ["auto_consent", "accepted", "picker", "app"],
      ["auto_consent", "shown", "picker", "app"],
      ["auto_consent", "declined", "picker", "app"],
    ]);
    expect(capture.mock.calls[0][1].version).toBeGreaterThanOrEqual(2);
  });
});
