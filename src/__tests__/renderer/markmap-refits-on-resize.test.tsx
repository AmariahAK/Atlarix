/**
 * QA (app) #19: a mind map in a plan reply rendered mostly empty, its content
 * crammed at the bottom-left and cut off. It was fitted once, right after it
 * was created — when its box can still be unsized (a collapsed card, a list
 * row not laid out yet) — and never again. It now refits when its box's size
 * changes (opening the card, resizing the window).
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { act, render } from "@testing-library/react";

const fit = vi.fn(async () => {});
vi.mock("markmap-view", () => ({
  Markmap: { create: vi.fn(() => ({ setData: vi.fn(), fit, rescale: vi.fn(), destroy: vi.fn() })) },
}));
vi.mock("markmap-lib", () => ({
  Transformer: class {
    transform() {
      return { root: { children: [] } };
    }
  },
}));
vi.mock("@/contexts/ThemeContext", () => ({
  useTheme: () => ({ theme: "light", isDarkMode: false, setTheme: () => {} }),
}));

let resize: ((entries: Array<{ contentRect: { width: number; height: number } }>) => void) | null = null;
class FakeResizeObserver {
  constructor(cb: typeof resize) {
    resize = cb;
  }
  observe() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", FakeResizeObserver);

import { MarkmapRenderer } from "@/components/chat/MarkmapRenderer";

describe("a mind map whose box gets its size later", () => {
  it("refits once it has a size", async () => {
    vi.useFakeTimers();
    render(<MarkmapRenderer content={"# Plan\n## Step one\n## Step two"} />);
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    vi.useRealTimers();
    fit.mockClear();
    expect(resize).not.toBeNull();
    await act(async () => resize!([{ contentRect: { width: 600, height: 320 } }]));
    expect(fit).toHaveBeenCalled();
  });
});
