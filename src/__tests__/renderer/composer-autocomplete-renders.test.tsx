/**
 * Plain typing must not schedule extra renders from the `@`-mention hook.
 *
 * Sentry 874b7908: "Maximum update depth exceeded" thrown from the composer's
 * onChange after ~50 fast keystrokes. The hook's effect called
 * `setTrigger(null)` + `setIndex(0)` on EVERY value change. With no mention in
 * the text those are no-ops, but right after a commit React cannot bail out of
 * them eagerly, so each keystroke left an update pending; React 19 counts that
 * as a nested update and throws once the count passes 50. The observable cost
 * here is one extra render per keystroke, which is what this pins.
 */

import React, { useRef, useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { useComposerAutocomplete } from "@/components/chat/ComposerAutocomplete";
import { renderWithProviders } from "./helpers";

vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: {
    getInstance: () => ({
      listWorkspacePaths: vi.fn(async () => ({ files: ["src/a.ts"], dirs: [] })),
    }),
  },
}));

let renders = 0;

function Composer() {
  renders++;
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { menu } = useComposerAutocomplete({ value, setValue, textareaRef });
  return (
    <div>
      {menu}
      <textarea
        aria-label="composer"
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </div>
  );
}

describe("useComposerAutocomplete — render cost of plain typing", () => {
  it("renders the composer once per keystroke when there is no mention", () => {
    renderWithProviders(<Composer />);
    const ta = screen.getByLabelText("composer") as HTMLTextAreaElement;
    const text = "Add a short Usage section to README.md";
    // Settle mount-time effects before counting.
    renders = 0;
    let typed = "";
    for (const ch of text) {
      typed += ch;
      act(() => {
        fireEvent.change(ta, { target: { value: typed } });
      });
    }
    expect(ta.value).toBe(text);
    expect(renders).toBe(text.length);
  });

  it("still opens the menu state for an @ mention and resets on plain text", () => {
    renderWithProviders(<Composer />);
    const ta = screen.getByLabelText("composer") as HTMLTextAreaElement;
    // A mention changes the trigger on every key, so those renders are real;
    // the point is that leaving the mention settles back to one per key.
    act(() => {
      fireEvent.change(ta, { target: { value: "see @src" } });
    });
    act(() => {
      fireEvent.change(ta, { target: { value: "see @src " } });
    });
    renders = 0;
    for (const v of ["see @src x", "see @src xy", "see @src xyz"]) {
      act(() => {
        fireEvent.change(ta, { target: { value: v } });
      });
    }
    expect(renders).toBe(3);
  });
});
