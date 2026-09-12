/**
 * The kernel must still be self-contained AFTER esbuild has bundled it.
 *
 * `page-scripts-portable.test.ts` checks the source on disk. That is not the
 * text the extension ships: `scripts/build-extension.mjs` runs the module
 * through esbuild first, and several perfectly ordinary bundler settings rewrite
 * a function body so that `.toString()` starts naming things that do not exist
 * in a page:
 *
 *   - **`keepNames: true`** wraps declarations in `__name(fn, "fn")`, and it
 *     does so for NESTED declarations too — which drops a module-scope
 *     reference straight into the middle of the kernel.
 *   - **a `target` below es2017** downlevels async/await into
 *     `__async(this, null, function* () {…})`, same problem by another route.
 *   - **emit helpers** for `enum`, class fields, spread downlevelling.
 *
 * Every one of those produces a ReferenceError in the page and nowhere else: the
 * desktop is unaffected (it never bundles this file), the type-checker is happy,
 * and the source-text test passes. So the build settings are pinned HERE, by
 * running the real bundler against the real module and asking the real exported
 * function what its source is — the same `.toString()` both backends call.
 *
 * WHY THIS IS THE NODE PROJECT AND NOT THE JSDOM ONE. esbuild refuses to start
 * under jsdom: it asserts `new TextEncoder().encode("") instanceof Uint8Array`,
 * and jsdom supplies those two from different realms, so the check is false and
 * it throws an invariant violation before any build runs. The consequence is a
 * deliberate split — self-containment of the BUNDLED source is proven here, and
 * the behaviour of the kernel against real DOM is proven unbundled in
 * `renderer/page-scripts-injectable.test.tsx`. Neither half is skipped.
 */

import { build } from "esbuild";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { A11ySnapshot, PageRequest } from "@/lib/browser/page-scripts";

const ENTRY = join(
  __dirname,
  "..",
  "lib",
  "browser",
  "page-scripts",
  "index.ts",
);

/** Exactly the settings `scripts/build-extension.mjs` uses. */
const BUILD_SETTINGS = {
  entryPoints: [ENTRY],
  bundle: true,
  format: "esm" as const,
  platform: "browser" as const,
  target: ["chrome116"],
  write: false as const,
  logLevel: "silent" as const,
};

type Kernel = (req: PageRequest) => A11ySnapshot;

/**
 * Bundle the module and load the result, so the function under test is the one
 * that would actually ship. The module has zero imports, so the bundle is
 * self-contained and a data: URL is enough to evaluate it.
 */
async function loadBundledKernel(
  overrides: Record<string, unknown> = {},
): Promise<Kernel> {
  const result = await build({ ...BUILD_SETTINGS, ...overrides });
  const code = result.outputFiles[0].text;
  const url =
    "data:text/javascript;base64," +
    Buffer.from(code, "utf8").toString("base64");
  const mod = (await import(/* @vite-ignore */ url)) as {
    atlarixPageKernel: Kernel;
  };
  return mod.atlarixPageKernel;
}

describe("the kernel survives the extension's bundler", () => {
  it("carries no esbuild helper reference with the shipped settings", async () => {
    const src = (await loadBundledKernel()).toString();
    // `__name`, `__async`, `__spreadValues` … all module-scope, all fatal here.
    expect(src).not.toMatch(/\b__name\s*\(/);
    expect(src).not.toMatch(/\b__async\s*\(/);
    expect(src).not.toMatch(/\b__spread\w*\s*\(/);
    expect(src).not.toMatch(/\b__publicField\s*\(/);
  }, 30_000);

  /**
   * The companion case, and the reason this file earns its runtime: it proves
   * the danger is real rather than asserting the current settings are fine. If
   * esbuild ever stops injecting `__name` for nested declarations this fails,
   * and that is the correct outcome — the pin would have become a superstition
   * and should be re-derived rather than trusted.
   */
  it("DOES break under keepNames, which is why the build pins it off", async () => {
    const src = (await loadBundledKernel({ keepNames: true })).toString();
    expect(src).toMatch(/\b__name\s*\(/);
  }, 30_000);

  /**
   * THE DESKTOP'S BUNDLER IS NOT ESBUILD.
   *
   * The main process is built by Vite (Rolldown under Vite 8) with minification
   * ON — the shipped bundle mangles module constants down to names like `Kkt`.
   * That is a second, independent chance to break `.toString()`, and a worse one
   * to reason about than esbuild's: a minifier is free to hoist a repeated
   * literal into a module-scope variable, which would leave the kernel
   * referencing a name that does not exist in the page. Nothing else in the
   * suite would notice — the source-text test reads the file on disk, and the
   * case above uses a different bundler entirely.
   */
  it("carries no helper through Vite/Rolldown either, which is what the desktop ships", async () => {
    const { build: viteBuild } = await import("vite");
    const { default: nodePath } = await import("node:path");
    const outDir = nodePath.join(
      __dirname,
      "..",
      "..",
      "node_modules",
      ".tmp",
      "kernel-vite",
    );
    await viteBuild({
      logLevel: "silent",
      resolve: { alias: { "@": nodePath.join(__dirname, "..") } },
      build: {
        outDir,
        emptyOutDir: true,
        minify: true,
        sourcemap: false,
        lib: { entry: ENTRY, formats: ["es"], fileName: "kernel" },
      },
    });
    const mod = (await import(
      /* @vite-ignore */ nodePath.join(outDir, "kernel.mjs")
    )) as { atlarixPageKernel: Kernel };
    const src = mod.atlarixPageKernel.toString();
    expect(src).not.toMatch(/\b__name\s*\(/);
    expect(src).not.toMatch(/\b__async\s*\(/);
    // The decisive one: it must still compile with no module around it.
    expect(typeof new Function(`return (${src})`)()).toBe("function");
  }, 60_000);

  it("is still self-contained after minification", async () => {
    // Minification renames identifiers, but self-consistently WITHIN the
    // function. Constructing it in global scope is the self-containment proof:
    // `new Function` compiles the body with no enclosing module, so a surviving
    // outer reference is a syntax-level free variable that resolves to nothing.
    // Executing it needs a DOM, which is the renderer project's half.
    const src = (await loadBundledKernel({ minify: true })).toString();
    expect(src).not.toMatch(/\b__name\s*\(/);
    const detached = new Function(`return (${src})`)();
    expect(typeof detached).toBe("function");
    expect(detached.length).toBe(1);
  }, 30_000);
});
