/**
 * Types for `binary-arch.mjs`.
 *
 * The build scripts are plain `.mjs` (they run under bare node, before any build
 * step), but `src/__tests__/binary-arch.test.ts` imports this module — so without a
 * declaration the typecheck fails with TS7016. Hand-written rather than generated
 * because the surface is three functions and will not drift.
 */

/** node-style arch names, e.g. `["arm64"]` or `["x64","arm64"]` for a universal binary. */
export declare function readBinaryArchs(file: string): string[];

/** Map a Rust target triple to the node-style arch it produces. */
export declare function archForTriple(triple: string): "arm64" | "x64" | "ia32";

/**
 * Throw unless `file` contains code for `expected`. A universal binary satisfies
 * any arch it actually carries. Returns the archs found.
 */
export declare function assertBinaryArch(
  file: string,
  expected: string,
  tag?: string,
): string[];
