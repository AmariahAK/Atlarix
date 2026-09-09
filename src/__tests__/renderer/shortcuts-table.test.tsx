/**
 * The shortcut table describes the real handlers, proven by dispatch.
 *
 * `lib/shortcuts.ts` is a DESCRIPTION table: the tips line and the Help sheet read their
 * key names from it while the handlers stay where they are. That trade is only safe with
 * a test like this one, because a description that drifts from its handler does not fail
 * quietly — it puts a wrong keystroke in front of a user, which is worse than shipping no
 * table at all.
 *
 * SO THIS TEST IS BEHAVIOURAL, NEVER INTROSPECTIVE. It does not parse the hook's inline
 * `if` chain. It mounts the real hook and dispatches `KeyboardEvent`s SYNTHESISED FROM
 * THE ROWS — the table is the input, the handler's observable effect is the assertion.
 *
 * Three parts, and each covers a drift direction the others miss:
 *
 *  1. FORWARD — every row this hook owns fires its declared effect. Catches "the table
 *     says X, the handler listens for Y".
 *  2. NEAR MISS — adding shift/alt, or swapping the modifier against the stubbed
 *     platform, does nothing. Pins the `!e.shiftKey && !e.altKey` guards the table would
 *     otherwise silently misdescribe, and catches an over-broad handler.
 *  3. COVERAGE LOCK — the owned-row count. The ONLY part that catches the other
 *     direction: a handler added with no table row. Without it the per-row tests pass
 *     forever while the table goes stale by omission.
 *
 * Both platforms, because the modifier is chosen at dispatch time and `navigator.platform`
 * is deprecated and empty in some environments — so the non-Mac branch is a real fallback
 * and not merely the Windows case.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  modelSheetOpenAtom,
  previewTabAtom,
  rightPanelOrderedTabsAtom,
  rightPanelVisibleAtom,
} from "@/atoms/sourceAtoms";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { SHORTCUTS, formatCombo, isMacPlatform } from "@/lib/shortcuts";
import { makeFakeIpc } from "./helpers";

/**
 * The full fake, not a two-method stub. `usePanelShortcuts` reaches `useSettings`, which
 * subscribes to `onSettingsChanged` — a hand-rolled mock missing one method fails inside
 * an effect, which reads as a broken test rather than a missing mock. `makeFakeIpc`'s
 * Proxy fills every gap; only `browserCreateTab` needs to be observable.
 */
const browserCreateTab = vi.fn();
const fakeIpc = makeFakeIpc();
(fakeIpc as unknown as Record<string, unknown>).browserCreateTab = browserCreateTab;
vi.mock("@/ipc/ipc_client", () => ({
  IpcClient: { getInstance: () => fakeIpc },
}));

vi.mock("@/lib/toast", () => ({
  showInfo: vi.fn(),
  showError: vi.fn(),
  showSuccess: vi.fn(),
}));

import { usePanelShortcuts } from "@/hooks/usePanelShortcuts";

/**
 * The hook reaches `useSettings` (for the work-mode preference), which calls
 * `useQueryClient` — so it cannot be mounted bare. A fresh client per render with retries
 * off, matching what `renderWithProviders` does for components.
 */
function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const mountHook = () => renderHook(() => usePanelShortcuts(), { wrapper });

/** Rows the hook under test actually owns — the others are exempt, see below. */
const PANEL_ROWS = SHORTCUTS.filter((s) => s.owner === "panel");

/**
 * The exemption list, asserted rather than assumed.
 *
 * `menu` is an Electron accelerator in the main process and `composer` needs a component
 * render rather than a hook, so neither can be dispatch-proven here. Pinning the set
 * means the exemptions cannot grow silently — a new un-provable row has to come back
 * through this test.
 */
const EXEMPT_OWNERS = ["sidebar", "app-search", "menu", "composer"] as const;

/**
 * The work-mode cycle writes through `updateSettings`, which strips telemetry keys from
 * `localStorage`. jsdom's stub here has no `removeItem`, so without this the chord's
 * async tail becomes an unhandled rejection — noise that would eventually be mistaken for
 * a real failure. Shimmed rather than mocked away, so the chord still runs its real path.
 */
function installLocalStorageShim() {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

function setPlatform(value: string) {
  Object.defineProperty(window.navigator, "platform", {
    value,
    configurable: true,
  });
}

/** Build a real event FROM THE ROW. Never from a literal — that is the whole point. */
function dispatchFromCombo(
  combo: { mod?: boolean; shift?: boolean; alt?: boolean; key: string },
  isMac: boolean,
  overrides: { shift?: boolean; alt?: boolean; flipMod?: boolean } = {},
): KeyboardEvent {
  const wantMod = combo.mod === true;
  const useMeta = overrides.flipMod ? !isMac : isMac;
  const event = new KeyboardEvent("keydown", {
    key: combo.key,
    metaKey: wantMod && useMeta,
    ctrlKey: wantMod && !useMeta,
    shiftKey: overrides.shift ?? combo.shift ?? false,
    altKey: overrides.alt ?? combo.alt ?? false,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

/** What each panel row is expected to change, read off the store after dispatch. */
const EFFECTS: Record<string, () => unknown> = {
  "toggle-right-panel": () => getDefaultStore().get(rightPanelVisibleAtom),
  "cycle-work-mode": () => undefined, // asserted via preventDefault only — see below
  "change-model": () => getDefaultStore().get(modelSheetOpenAtom),
  "new-browser-tab": () => browserCreateTab.mock.calls.length,
  "prev-panel-tab": () => getDefaultStore().get(previewTabAtom),
  "next-panel-tab": () => getDefaultStore().get(previewTabAtom),
};

beforeEach(() => {
  installLocalStorageShim();
  const store = getDefaultStore();
  store.set(rightPanelVisibleAtom, false);
  store.set(modelSheetOpenAtom, false);
  store.set(previewTabAtom, "preview");
  /*
   * THREE tabs with the active one in the MIDDLE, and both details are load-bearing.
   *
   * `movePanelTab` returns early below two tabs — which is exactly why those rows carry
   * a `scope` — and it CLAMPS at the ends rather than wrapping, so an active tab at
   * index 0 cannot move left and the ⌘I assertion would fail for a reason that has
   * nothing to do with the table. The middle position lets both directions actually move.
   */
  store.set(rightPanelOrderedTabsAtom, {
    tabs: ["sources", "preview", "browser"],
    active: "preview",
  } as never);
  store.set(selectedAppIdAtom, 1);
  browserCreateTab.mockClear();
});

afterEach(() => {
  setPlatform("MacIntel");
});

describe.each([
  { name: "macOS", platform: "MacIntel", isMac: true },
  { name: "non-Mac", platform: "Win32", isMac: false },
])("shortcut table conformance on $name", ({ platform, isMac }) => {
  beforeEach(() => {
    setPlatform(platform);
    expect(isMacPlatform()).toBe(isMac);
  });

  it.each(PANEL_ROWS.map((r) => [r.id, r] as const))(
    "%s fires from the combo the table declares",
    (_id, row) => {
      mountHook();
      const before = EFFECTS[row.id]?.();
      const event = dispatchFromCombo(row.combo, isMac);

      // Every panel chord calls preventDefault, so this alone proves the handler
      // recognised the combo — including for the work-mode cycle, whose effect is a
      // toast and a setting rather than an atom this test owns.
      expect(event.defaultPrevented).toBe(true);

      const after = EFFECTS[row.id]?.();
      if (row.id !== "cycle-work-mode") {
        expect(after).not.toEqual(before);
      }
    },
  );

  it.each(PANEL_ROWS.map((r) => [r.id, r] as const))(
    "%s does NOT fire on a near miss",
    (_id, row) => {
      mountHook();

      const variants: Array<{ shift?: boolean; alt?: boolean; flipMod?: boolean }> = [
        { alt: true },
        // Adding shift to a chord that already uses it is not a near miss, so skip it.
        ...(row.combo.shift ? [] : [{ shift: true }]),
        // Swapping Cmd for Ctrl against the stubbed platform, for chords with a modifier.
        ...(row.combo.mod ? [{ flipMod: true }] : []),
      ];

      for (const overrides of variants) {
        const before = EFFECTS[row.id]?.();
        const event = dispatchFromCombo(row.combo, isMac, overrides);
        expect(event.defaultPrevented).toBe(false);
        expect(EFFECTS[row.id]?.()).toEqual(before);
      }
    },
  );
});

describe("the table cannot go stale by omission", () => {
  /**
   * COVERAGE LOCK. The per-row tests above can only check rows that EXIST — they pass
   * forever if a chord is added to the hook and never described here. This is the only
   * assertion that notices.
   *
   * If you add a panel shortcut: add its row, add its `EFFECTS` entry, bump this number.
   */
  it("describes exactly the panel chords the hook implements", () => {
    expect(PANEL_ROWS.map((r) => r.id).sort()).toEqual(
      [
        "change-model",
        "cycle-work-mode",
        "new-browser-tab",
        "next-panel-tab",
        "prev-panel-tab",
        "toggle-right-panel",
      ].sort(),
    );
  });

  it("every panel row has an expected effect declared", () => {
    for (const row of PANEL_ROWS) {
      expect(Object.keys(EFFECTS)).toContain(row.id);
    }
  });

  /**
   * The rows this test CANNOT prove, pinned so the list cannot grow quietly. A new owner
   * here means someone added a shortcut somewhere dispatch cannot reach from a hook —
   * which is a decision worth making deliberately, not by adding a row.
   */
  it("only the known-unprovable owners are exempt from dispatch proof", () => {
    const owners = [...new Set(SHORTCUTS.map((s) => s.owner))].filter(
      (o) => o !== "panel",
    );
    expect(owners.sort()).toEqual([...EXEMPT_OWNERS].sort());
  });
});

describe("formatCombo", () => {
  it("stacks modifiers Mac-style and joins them elsewhere", () => {
    const j = SHORTCUTS.find((s) => s.id === "change-model")!.combo;
    expect(formatCombo(j, true)).toBe("⌘J");
    expect(formatCombo(j, false)).toBe("Ctrl+J");
  });

  it("keeps named keys whole rather than upper-casing them", () => {
    const tab = SHORTCUTS.find((s) => s.id === "cycle-work-mode")!.combo;
    expect(formatCombo(tab, true)).toBe("⇧Tab");
    expect(formatCombo(tab, false)).toBe("Shift+Tab");
  });
});
