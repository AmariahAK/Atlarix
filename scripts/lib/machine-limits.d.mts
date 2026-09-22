/**
 * Hand-written typings for `machine-limits.mjs`.
 *
 * The module stays plain `.mjs` because `scripts/forge-with-heap.mjs` is run by
 * bare `node` from an npm script and `vitest.config.mts` imports it before any
 * build step exists — neither can wait on a compile. So the types are declared
 * here rather than the source being converted to TypeScript.
 */

/** V8 heap floor for a packaging run, in MB. */
export const HEAP_FLOOR_MB: number;
/** V8 heap ceiling for a packaging run, in MB. */
export const HEAP_CEILING_MB: number;
/** RAM assumed per concurrent test worker, in GB. */
export const MEMORY_PER_WORKER_GB: number;
/** Lowest worker count the policy will choose. */
export const MIN_WORKERS: number;

/**
 * `--max-old-space-size` for a packaging run, in MB.
 *
 * @param totalMemBytes total physical memory, e.g. `os.totalmem()`
 * @param env environment to read `ATLARIX_PACKAGE_HEAP_MB` from
 */
export function resolveHeapMb(
  totalMemBytes: number,
  env?: Record<string, string | undefined>,
): number;

/**
 * How many test suites may run at once.
 *
 * @param cpuCount logical CPUs, e.g. `os.cpus().length`
 * @param totalMemBytes total physical memory, e.g. `os.totalmem()`
 * @param env environment to read `VITEST_MAX_WORKERS` from
 */
export function resolveMaxWorkers(
  cpuCount: number,
  totalMemBytes: number,
  env?: Record<string, string | undefined>,
): number;
