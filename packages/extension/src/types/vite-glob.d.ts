/**
 * `import.meta.glob` — declared by hand, and **usable in tests ONLY**.
 *
 * WHY IT IS NOT IN `types`. This package sets `types: []` so that a Node
 * builtin cannot type-check, and pulling in `vite/client` to get this one
 * signature would hand every file `import.meta.env` as well — a second way to
 * read configuration that the build does not substitute. Declaring the single
 * API actually used is the same choice `chrome.d.ts` makes, for the same
 * reason: adding to it should be a deliberate edit with a stated cause.
 *
 * WHY TESTS ONLY, AND THIS IS THE IMPORTANT PART. `import.meta.glob` is a VITE
 * transform. `scripts/build-extension.mjs` bundles with esbuild, which does not
 * implement it — so a source file using this would type-check, pass the test
 * suite (vitest runs through Vite), and then ship a bundle containing a literal
 * `import.meta.glob(...)` call that throws in the browser. Vitest passing is
 * not evidence the extension build works.
 *
 * `no-node-globals.test.ts` enforces the tests-only rule, and uses this itself
 * to read the package's sources without touching `node:fs`.
 */

interface ImportMeta {
  glob(
    pattern: string,
    options: { query: "?raw"; import: "default"; eager: true },
  ): Record<string, string>;
}
