/**
 * EVERY key in EVERY bundled catalog must resolve to real prose.
 *
 * THE BUG THIS EXISTS FOR, and it had shipped: `t()` returned its own key for every
 * string in the app. i18next NORMALISES a language code before looking a key up
 * (`en-us` → `en-US`) while storing the bundle under the literal key it was handed —
 * and our locale identifiers are lowercase everywhere, so the store was keyed `en-us`
 * and the lookup asked for `en-US`. `lowerCaseLng: true` is the fix.
 *
 * WHY NOTHING CAUGHT IT. Neither guard was looking at the value:
 *   - `check:i18n` compares catalog SHAPES between locales and counts hardcoded JSX.
 *     Two catalogs can agree perfectly and still both fail to resolve.
 *   - TypeScript checks that a key EXISTS in the catalog type, which it did.
 *   - `parseMissingKeyHandler` renders the key, so a miss looks like content.
 *   - Most call sites pass a `defaultValue` — the shortcut rows do — so they showed
 *     correct English from the fallback and looked completely fine.
 *   - The renderer tests asserted a tip RENDERED, never that its text was not a key.
 *
 * The feature tips were the only strings with no defaultValue, which is why
 * `feature.automations` was the first visible symptom rather than the first failure.
 *
 * So this walks the real catalogs and asserts on the RESOLVED VALUE. It is deliberately
 * about values, not shapes, because shape was never the problem.
 */

import { describe, expect, it } from "vitest";
import { EN_RESOURCES, NAMESPACES, createI18n } from "@/lib/i18n";

/** Every leaf key path in a nested catalog, dot-joined the way `t()` takes them. */
function leafKeyPaths(obj: unknown, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object") return prefix ? [prefix] : [];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    leafKeyPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

const i18n = createI18n();

/**
 * `t()` with a RUNTIME key, and deliberately without a `defaultValue`.
 *
 * The typed signature demands a literal key or a `defaultValue`, and supplying the
 * latter is exactly what hid this bug: `t(key, { defaultValue })` renders correct
 * English even when lookup fails outright. So the type is escaped instead — the
 * subject here is the resolved VALUE, and a defaultValue would make every assertion
 * below unfalsifiable.
 */
const tRaw = (key: string, ns: string): string =>
  String((i18n.t as unknown as (k: string, o: object) => unknown)(key, { ns }));

describe("bundled catalogs resolve", () => {
  it("has at least one non-empty catalog to check, or this test proves nothing", () => {
    // Guards the vacuous case: most catalogs are still `{}` while the UI is
    // translated surface by surface, and an all-empty sweep would pass silently.
    const total = NAMESPACES.reduce(
      (n, ns) =>
        n +
        leafKeyPaths((EN_RESOURCES as Record<string, unknown>)[ns] ?? {})
          .length,
      0,
    );
    expect(total).toBeGreaterThan(20);
  });

  it.each([...NAMESPACES])(
    "every key in the %s catalog returns prose",
    (ns) => {
      const catalog = (EN_RESOURCES as Record<string, unknown>)[ns] ?? {};
      const paths = leafKeyPaths(catalog);
      const unresolved = paths.filter((key) => tRaw(key, ns) === key);
      expect(unresolved).toEqual([]);
    },
  );

  it("resolves a NESTED key, which is the shape the failure hid in", () => {
    // A flat top-level key and a nested one fail together here, but nesting is what
    // every real catalog uses, so it is the case worth naming.
    expect(tRaw("help.title", "tips")).toBe("Keyboard shortcuts");
  });

  it("resolves without a defaultValue masking the result", () => {
    // The trap: `t(key, { defaultValue })` renders correct English even when lookup
    // fails completely, so a passing UI proves nothing. No defaultValue anywhere here.
    const v = tRaw("shortcuts.change-model", "tips");
    expect(v).not.toBe("shortcuts.change-model");
    expect(v).toContain("model");
  });
});
