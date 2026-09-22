/**
 * How much of THIS machine the build and test tooling may take.
 *
 * Both numbers below used to be sized to the CPU alone, or hardcoded outright,
 * and on an 8 GB laptop that is how a test run or a package run takes the whole
 * operating system down rather than merely being slow.
 *
 * Measured on the 8 GB / 8-logical-core MacBook Air this repo is developed on,
 * while the full suite and a package run overlapped:
 *
 *   free memory        4%
 *   swap in use        39.7 GB of a 41 GB swap file
 *   kernel_task        151% CPU   ← macOS throttling a thrashing system
 *   load average       16.87
 *   Atlarix itself     404 MB     ← not the cause; the tooling was
 *
 * Every app on the machine lagged and it ended in a hard restart. Note the last
 * line: the app under development was a rounding error next to the tools
 * building it, which is exactly why this was mis-diagnosed as an app problem
 * first.
 *
 * Pure functions taking the machine's shape as arguments, so the policy can be
 * tested against a 4 GB box and a 64 GB box without owning either.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** V8 heap ceiling for a packaging run, in MB. */
export const HEAP_FLOOR_MB = 2048;
export const HEAP_CEILING_MB = 8192;

/** RAM assumed per concurrent test worker (a Node process, often plus jsdom). */
export const MEMORY_PER_WORKER_GB = 2;

/** Lowest worker count we will pick; below this the suite is serial enough to hurt. */
export const MIN_WORKERS = 2;

function positiveIntOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * `--max-old-space-size` for a packaging run.
 *
 * Half the machine. `--max-old-space-size` is a promise about how far V8 may
 * grow before it MUST collect, not a reservation checked against what is free —
 * so handing an 8 GB machine the number 8192 means "do not bother collecting
 * until you have consumed the entire machine", and V8 obliges.
 *
 * The ceiling is not timidity: past ~8 GB the packaging bottleneck is file I/O,
 * and a larger heap only delays collection further.
 */
export function resolveHeapMb(totalMemBytes, env = {}) {
  const override = positiveIntOrNull(env.ATLARIX_PACKAGE_HEAP_MB);
  if (override) return override;
  const halfMachine = Math.floor(totalMemBytes / MB / 2);
  return Math.min(HEAP_CEILING_MB, Math.max(HEAP_FLOOR_MB, halfMachine));
}

/**
 * How many test suites may run at once.
 *
 * Vitest's default is `ncpu - 1` forked processes and it never consults RAM.
 * Take the lower of what the CPU allows and what the memory allows — the CPU
 * stays the binding limit on a build server, and memory becomes it on a laptop,
 * which is the case the default gets wrong.
 */
export function resolveMaxWorkers(cpuCount, totalMemBytes, env = {}) {
  const override = positiveIntOrNull(env.VITEST_MAX_WORKERS);
  if (override) return override;
  const byCpu = Math.max(1, cpuCount - 1);
  const byMemory = Math.floor(totalMemBytes / GB / MEMORY_PER_WORKER_GB);
  return Math.max(MIN_WORKERS, Math.min(byCpu, byMemory));
}
