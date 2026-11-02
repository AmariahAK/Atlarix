/**
 * The paste duplication bug (TODO #10): pasting content into the composer must
 * NEVER land twice — once as an attachment chip and again as inline text, or as
 * two copies of the same attachment sent to the model.
 *
 * The invariant is "a paste is either captured (preventDefault) or left to the
 * browser (no preventDefault), never both". `handlePaste` calls
 * `preventDefault()` synchronously for the three cases it handles itself — an
 * image, a terminal selection, or a long text paste — so the controlled
 * textarea does not also insert the text. A short paste gets no
 * `preventDefault`, so the browser inserts it exactly once. And the attachment
 * merge dedupes by content key, so even a double event can't add two chips.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import type React from "react";
import { attachmentsAtom } from "@/atoms/chatAtoms";
import { useAttachments } from "@/hooks/useAttachments";

/** A clipboard stand-in: only the members `handlePaste` actually reads. */
function makeClipboard(opts: {
  plainText?: string;
  html?: string;
  items?: Array<{ type: string; file?: File | null }>;
}): DataTransfer {
  const data: Record<string, string> = {
    "text/plain": opts.plainText ?? "",
    "text/html": opts.html ?? "",
  };
  return {
    items: (opts.items ?? []).map((i) => ({
      type: i.type,
      getAsFile: () => i.file ?? null,
    })),
    getData: (mime: string) => data[mime] ?? "",
  } as unknown as DataTransfer;
}

function makeEvent(clipboard: DataTransfer) {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  return {
    clipboardData: clipboard,
    preventDefault,
    stopPropagation,
  } as unknown as React.ClipboardEvent;
}

const LONG_TEXT = "a".repeat(501); // above the 500-char capture threshold

beforeEach(() => {
  // Renderer hooks read the DEFAULT Jotai store; each test starts empty.
  getDefaultStore().set(attachmentsAtom, []);
});

describe("composer paste handling", () => {
  it("captures a long paste with preventDefault, so it is never also inserted inline", () => {
    const { result } = renderHook(() => useAttachments());
    const evt = makeEvent(makeClipboard({ plainText: LONG_TEXT }));

    act(() => {
      result.current.handlePaste(evt);
    });

    expect(evt.preventDefault).toHaveBeenCalledTimes(1);
    expect(evt.stopPropagation).toHaveBeenCalledTimes(1);
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0]?.textPaste?.content).toBe(LONG_TEXT);
  });

  it("leaves a short paste to the browser (no preventDefault, no chip)", () => {
    const { result } = renderHook(() => useAttachments());
    const evt = makeEvent(makeClipboard({ plainText: "three short sentences." }));

    act(() => {
      result.current.handlePaste(evt);
    });

    expect(evt.preventDefault).not.toHaveBeenCalled();
    expect(evt.stopPropagation).not.toHaveBeenCalled();
    expect(result.current.attachments).toHaveLength(0);
  });

  it("never adds a second copy of the same paste (dedupe by content)", () => {
    const { result } = renderHook(() => useAttachments());

    act(() => {
      result.current.handlePaste(makeEvent(makeClipboard({ plainText: LONG_TEXT })));
      result.current.handlePaste(makeEvent(makeClipboard({ plainText: LONG_TEXT })));
    });

    expect(result.current.attachments).toHaveLength(1);
  });

  it("captures a pasted image with preventDefault", () => {
    const { result } = renderHook(() => useAttachments());
    const file = new File(["png"], "shot.png", { type: "image/png" });
    const evt = makeEvent(makeClipboard({ items: [{ type: "image/png", file }] }));

    act(() => {
      result.current.handlePaste(evt);
    });

    expect(evt.preventDefault).toHaveBeenCalledTimes(1);
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0]?.file?.type).toBe("image/png");
  });
});
