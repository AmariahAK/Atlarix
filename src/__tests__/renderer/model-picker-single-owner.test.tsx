/**
 * ONE model picker answers Cmd/Ctrl+J, however many composers are mounted.
 *
 * WHY THIS TEST EXISTS. `ChatInputControls` can be mounted twice at once:
 * `PersistentChatContainer` hides itself with a CSS class rather than
 * unmounting (`app/layout.tsx`), and the right panel's Chat tab mounts a second
 * composer whenever the panel is dragged to within 80px of the window width
 * (`useRightPanelContext.ts`). `modelSheetOpenAtom` is a single global boolean,
 * so a picker bound straight to it would open in BOTH composers — two portalled
 * popovers, two search boxes, and whichever mounted last stealing the caret.
 *
 * Nothing else in the suite would catch that. `shortcuts-table.test.tsx` proves
 * the chord flips the atom and never renders a composer; the atom flipping is
 * exactly the part that still works when this breaks.
 *
 * The old right-edge `Sheet` had the same flaw and got away with it because two
 * identical overlays stack invisibly. The chip does not, so this is pinned.
 */

import { describe, expect, it } from "vitest";
import { render, act } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { modelSheetOpenAtom } from "@/atoms/sourceAtoms";
import { useModelPickerOpen } from "@/hooks/useModelPickerOpen";

function wrapper(store: ReturnType<typeof createStore>) {
  return ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
}

/** Two composers under one store, mounted in the order the app mounts them. */
function TwoComposers({ report }: { report: (which: string, open: boolean) => void }) {
  const main = useModelPickerOpen(1);
  const embedded = useModelPickerOpen(1);
  report("main", main.open);
  report("embedded", embedded.open);
  return null;
}

describe("the model picker's chord ownership", () => {
  it("opens exactly one picker when the chord fires with two composers mounted", () => {
    const store = createStore();
    const seen: Record<string, boolean> = {};
    render(<TwoComposers report={(k, v) => (seen[k] = v)} />, {
      wrapper: wrapper(store),
    });

    act(() => {
      store.set(modelSheetOpenAtom, true);
    });

    const openCount = Object.values(seen).filter(Boolean).length;
    expect(
      openCount,
      `expected one open picker, got ${openCount} (${JSON.stringify(seen)})`,
    ).toBe(1);
  });

  it("gives the chord to the LAST composer mounted", () => {
    // The embedded tab only exists while the main chat area is hidden, so the
    // most recently mounted composer is the one on screen. A single owner atom
    // written on mount would keep pointing at the first one.
    const store = createStore();
    const seen: Record<string, boolean> = {};
    render(<TwoComposers report={(k, v) => (seen[k] = v)} />, {
      wrapper: wrapper(store),
    });

    act(() => {
      store.set(modelSheetOpenAtom, true);
    });

    expect(seen.embedded).toBe(true);
    expect(seen.main).toBe(false);
  });

  it("clears the flag on unmount so the next composer does not open by itself", () => {
    const store = createStore();
    const { unmount } = renderHook(() => useModelPickerOpen(1), {
      wrapper: wrapper(store),
    });

    act(() => {
      store.set(modelSheetOpenAtom, true);
    });
    unmount();

    expect(store.get(modelSheetOpenAtom)).toBe(false);
  });

  it("closes when the thread changes", () => {
    const store = createStore();
    const { result, rerender } = renderHook(
      ({ chatId }: { chatId: number }) => useModelPickerOpen(chatId),
      { wrapper: wrapper(store), initialProps: { chatId: 1 } },
    );

    act(() => {
      store.set(modelSheetOpenAtom, true);
    });
    expect(result.current.open).toBe(true);

    rerender({ chatId: 2 });
    expect(result.current.open).toBe(false);
  });
});
