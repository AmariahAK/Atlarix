/**
 * Setup for the `extension` vitest project.
 *
 * WHAT THIS EXISTS FOR: jsdom is not a browser, and the gaps are not uniform
 * across this repo's projects. The `renderer` project imports
 * `@testing-library/jest-dom/vitest`, which happens to bring a `CSS.escape`
 * with it; the extension project imports nothing, so `CSS` is undefined there
 * entirely — while every browser the extension actually runs in has had
 * `CSS.escape` since 2016.
 *
 * That asymmetry is worth a shim rather than a workaround in each test. Code
 * that escapes a selector is doing the right thing, and a test environment that
 * punishes it teaches people to stop.
 *
 * TEST-ONLY, AND NOT A POLYFILL WE SHIP. Nothing here is bundled; the extension
 * calls the browser's own implementation. If this file ever grows something the
 * shipped code depends on, that dependency belongs in `src/`, not here.
 *
 * Related gaps in the same family, recorded so nobody rediscovers them:
 *   - jsdom does NOT implement `innerText`. `accName` reads it third, so a
 *     snapshot `name` must come from `aria-label` or `title` in a test.
 *   - esbuild refuses to run under jsdom at all — it asserts
 *     `new TextEncoder().encode("") instanceof Uint8Array` and jsdom supplies
 *     those from different realms.
 *   - jsdom-under-vitest KEEPS Node's globals, so `process` and `Buffer`
 *     resolve in a test and fail in Chrome. `src/no-node-globals.test.ts` is
 *     what actually enforces browser-safety; a green suite does not.
 */

const target = globalThis as unknown as {
  CSS?: { escape?: (value: string) => string };
};

if (typeof target.CSS?.escape !== "function") {
  /**
   * CSS.escape, per the CSSOM spec's serialize-an-identifier algorithm.
   *
   * Written out rather than approximated: a loose version that only quoted the
   * obvious characters would let a test pass on input the real implementation
   * escapes differently, which is worse than having no shim.
   */
  const escape = (value: string): string => {
    const string = String(value);
    const length = string.length;
    let index = -1;
    let codeUnit: number;
    let result = "";
    const firstCodeUnit = string.charCodeAt(0);

    while (++index < length) {
      codeUnit = string.charCodeAt(index);

      // NULL becomes the replacement character rather than throwing.
      if (codeUnit === 0x0000) {
        result += "�";
        continue;
      }

      if (
        // Control characters and DEL.
        (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
        codeUnit === 0x007f ||
        // A leading digit, or a digit after a leading hyphen.
        (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
        (index === 1 &&
          codeUnit >= 0x0030 &&
          codeUnit <= 0x0039 &&
          firstCodeUnit === 0x002d)
      ) {
        result += "\\" + codeUnit.toString(16) + " ";
        continue;
      }

      // A lone leading hyphen.
      if (index === 0 && length === 1 && codeUnit === 0x002d) {
        result += "\\" + string.charAt(index);
        continue;
      }

      // Everything already valid in an identifier passes through.
      if (
        codeUnit >= 0x0080 ||
        codeUnit === 0x002d ||
        codeUnit === 0x005f ||
        (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
        (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
        (codeUnit >= 0x0061 && codeUnit <= 0x007a)
      ) {
        result += string.charAt(index);
        continue;
      }

      result += "\\" + string.charAt(index);
    }
    return result;
  };

  target.CSS = { ...(target.CSS ?? {}), escape };
}
