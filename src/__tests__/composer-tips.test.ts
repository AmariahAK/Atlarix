/**
 * The tip POLICY, tested without a render.
 *
 * The behaviour is the whole feature here. A tip that flickers, that appears under a
 * half-typed message, or that advertises a chord which does nothing where the user is
 * standing, is worse than no tip at all — and every one of those is a policy bug rather
 * than a rendering bug, so it belongs in a test that does not need a DOM.
 */

import { describe, expect, it, vi } from "vitest";
import {
  FEATURE_TIP_IDS,
  buildTipPool,
  pickTip,
  type TipContext,
} from "@/lib/composer-tips";
import { advertisedShortcuts } from "@/lib/shortcuts";

const t = {
  shortcutAction: (id: string, fallback: string) => `action:${id}|${fallback}`,
  feature: (id: string) => `feature:${id}`,
};

const FULL: TipContext = {
  inWorkspaceChat: true,
  hasMultiplePanelTabs: true,
  isMac: true,
};

describe("the tip pool", () => {
  /*
   * THE POOL IS SOURCED FROM `advertisedShortcuts()`, NOT `SHORTCUTS`.
   *
   * REWRITTEN 2026-09-21, and the reason is worth keeping. This used to read
   * the real table, assert `hidden.length > 0`, and check that no hidden id
   * reached the pool. Two problems surfaced when ⌘K was fixed:
   *
   *  1. `app-search` was the ONLY hidden row, so the moment its listener was
   *     hoisted to the app root and the row became advertised, the test failed
   *     — it was pinned to a bug continuing to exist.
   *  2. The check itself had no teeth either way. `buildTipPool` maps over
   *     `advertisedShortcuts()` (`composer-tips.ts:111`), so a hidden row
   *     cannot reach the pool by construction. Flipping a real row to
   *     `hidden` and re-running left the test green.
   *
   * So the invariant is the SOURCING, and the only way to prove it is to hand
   * `buildTipPool` a table that contains a hidden row and watch it drop it. A
   * future edit that reaches for `SHORTCUTS` instead fails here.
   */
  it("drops hidden rows because it reads the advertised list, not the table", async () => {
    vi.resetModules();
    vi.doMock("@/lib/shortcuts", async () => {
      const real =
        await vi.importActual<typeof import("@/lib/shortcuts")>(
          "@/lib/shortcuts",
        );
      const table = [
        {
          id: "fake-advertised",
          combo: { mod: true, key: "1" },
          label: "Visible thing",
          owner: "panel",
          status: "advertised",
        },
        {
          id: "fake-hidden",
          combo: { mod: true, key: "2" },
          label: "Broken thing",
          owner: "panel",
          status: "hidden",
        },
      ];
      return {
        ...real,
        SHORTCUTS: table,
        advertisedShortcuts: () =>
          table.filter((s) => s.status === "advertised"),
      };
    });

    const { buildTipPool: build } = await import("@/lib/composer-tips");
    const ids = build(FULL, t).map((p) => p.id);

    expect(ids).toContain("shortcut:fake-advertised");
    expect(ids).not.toContain("shortcut:fake-hidden");

    vi.doUnmock("@/lib/shortcuts");
    vi.resetModules();
  });

  it("drops the work-mode tip outside a workspace chat", () => {
    // The chord toasts "Work modes are available in workspace chats" and does nothing,
    // so offering it elsewhere would be advertising a no-op.
    const outside = buildTipPool({ ...FULL, inWorkspaceChat: false }, t);
    const inside = buildTipPool(FULL, t);
    expect(outside.some((p) => p.id === "shortcut:cycle-work-mode")).toBe(
      false,
    );
    expect(inside.some((p) => p.id === "shortcut:cycle-work-mode")).toBe(true);
  });

  it("drops the panel-tab tips below two tabs", () => {
    // `movePanelTab` returns early below two tabs.
    const one = buildTipPool({ ...FULL, hasMultiplePanelTabs: false }, t);
    expect(one.some((p) => p.id === "shortcut:prev-panel-tab")).toBe(false);
    expect(one.some((p) => p.id === "shortcut:next-panel-tab")).toBe(false);
  });

  it("takes every chord from the shortcut table, never a literal", () => {
    const pool = buildTipPool(FULL, t);
    const shortcutTips = pool.filter((p) => p.id.startsWith("shortcut:"));
    expect(shortcutTips.length).toBeGreaterThan(0);
    for (const tip of shortcutTips) {
      const row = advertisedShortcuts().find(
        (s) => `shortcut:${s.id}` === tip.id,
      )!;
      expect(row).toBeTruthy();
      // Mac formatting, since FULL.isMac — proves the chord came from formatCombo and
      // not from prose someone typed into the catalog.
      expect(tip.keys).toBeTruthy();
      if (row.combo.mod) expect(tip.keys).toContain("⌘");
    }
  });

  it("offers every feature tip", () => {
    const pool = buildTipPool(FULL, t);
    for (const id of FEATURE_TIP_IDS) {
      expect(pool.some((p) => p.id === `feature:${id}`)).toBe(true);
    }
  });
});

describe("picking a tip", () => {
  const pool = buildTipPool(FULL, t);

  /**
   * THE MOST IMPORTANT PROPERTY. The composer re-renders constantly — on every keystroke
   * elsewhere, on every atom change — and a tip that re-rolled on each one would be the
   * flickering line this design exists to avoid. `Math.random()` would do exactly that.
   */
  it("is stable for the same key, however many times it is asked", () => {
    const first = pickTip("launch-1:chat-7", pool);
    for (let i = 0; i < 50; i++) {
      expect(pickTip("launch-1:chat-7", pool)).toEqual(first);
    }
  });

  it("can differ between keys, so a new chat is a fresh draw", () => {
    const results = new Set(
      Array.from(
        { length: 60 },
        (_, i) => pickTip(`launch-1:chat-${i}`, pool)?.id ?? null,
      ),
    );
    // More than one distinct outcome, or the hash is not distributing at all.
    expect(results.size).toBeGreaterThan(3);
  });

  it("hides on some keys — a tip that is always there is furniture", () => {
    const keys = Array.from({ length: 400 }, (_, i) => `k${i}`);
    const shown = keys.filter((k) => pickTip(k, pool) !== null).length;
    // Loose bounds on purpose: this asserts the mechanism works, not the exact ratio,
    // so tuning SHOW_PROBABILITY does not break the suite.
    expect(shown).toBeGreaterThan(keys.length * 0.4);
    expect(shown).toBeLessThan(keys.length * 0.9);
  });

  it("the hidden decision is stable too, and does not re-roll into view", () => {
    const hiddenKey = Array.from({ length: 400 }, (_, i) => `k${i}`).find(
      (k) => pickTip(k, pool) === null,
    )!;
    expect(hiddenKey).toBeTruthy();
    for (let i = 0; i < 30; i++) {
      expect(pickTip(hiddenKey, pool)).toBeNull();
    }
  });

  it("returns null for an empty pool rather than throwing", () => {
    expect(pickTip("anything", [])).toBeNull();
  });

  it("always shows at probability 1, and never at 0", () => {
    expect(pickTip("k", pool, 1)).not.toBeNull();
    expect(pickTip("k", pool, 0)).toBeNull();
  });
});
