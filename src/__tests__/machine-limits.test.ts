/**
 * How much of the machine the build and test tooling may take.
 *
 * This exists because the tooling took a developer machine down. Packaging
 * hardcoded `--max-old-space-size=8192` and Vitest defaulted to `ncpu - 1`
 * forked workers; neither consulted how much RAM the machine actually had. On
 * the 8 GB / 8-logical-core MacBook Air this repo is developed on, running both
 * produced:
 *
 *   free memory      4%
 *   swap in use      39.7 GB of a 41 GB swap file
 *   kernel_task      151% CPU   ← macOS throttling a thrashing system
 *   load average     16.87
 *   Atlarix itself   404 MB     ← not the cause; the tooling was
 *
 * Every app on the machine lagged, and it ended in a hard restart.
 *
 * The regressions worth catching are specific: someone re-hardcodes the heap,
 * or someone "optimises" the worker count back to the CPU count. Both look
 * harmless in review and both are only wrong on a machine the reviewer is not
 * using — so the sizes are asserted against machine shapes rather than against
 * whatever box happens to run this suite.
 */
import { describe, it, expect } from "vitest";
import {
  HEAP_CEILING_MB,
  HEAP_FLOOR_MB,
  MIN_WORKERS,
  resolveHeapMb,
  resolveMaxWorkers,
} from "../../scripts/lib/machine-limits.mjs";

const GB = 1024 ** 3;

describe("packaging heap", () => {
  it("does not hand an 8 GB machine the whole machine", () => {
    // THE REGRESSION. `--max-old-space-size` is a promise about how far V8 may
    // grow before it must collect, not a reservation checked against free
    // memory — so 8192 on an 8 GB box means "don't collect until the machine is
    // gone", and V8 obliges.
    expect(resolveHeapMb(8 * GB)).toBe(4096);
    expect(resolveHeapMb(8 * GB)).toBeLessThan(8192);
  });

  it("still gives a big machine a big heap", () => {
    expect(resolveHeapMb(16 * GB)).toBe(HEAP_CEILING_MB);
    expect(resolveHeapMb(64 * GB)).toBe(HEAP_CEILING_MB);
  });

  it("never drops below a workable floor on a small machine", () => {
    // Half of 2 GB is 1 GB, which cannot package this app at all. Failing to
    // build is not an improvement on building slowly.
    expect(resolveHeapMb(2 * GB)).toBe(HEAP_FLOOR_MB);
    expect(resolveHeapMb(1 * GB)).toBe(HEAP_FLOOR_MB);
  });

  it("yields to an explicit override", () => {
    expect(resolveHeapMb(8 * GB, { ATLARIX_PACKAGE_HEAP_MB: "6144" })).toBe(
      6144,
    );
    // Garbage must not silently become a heap size.
    expect(
      resolveHeapMb(8 * GB, { ATLARIX_PACKAGE_HEAP_MB: "not-a-number" }),
    ).toBe(4096);
    expect(resolveHeapMb(8 * GB, { ATLARIX_PACKAGE_HEAP_MB: "-1" })).toBe(4096);
  });
});

describe("test worker count", () => {
  it("is bounded by MEMORY on the machine that crashed, not by CPU", () => {
    // 8 logical cores said 7 workers. 8 GB of RAM says 4. The whole point.
    expect(resolveMaxWorkers(8, 8 * GB)).toBe(4);
  });

  it("leaves CPU as the binding limit where memory is not scarce", () => {
    // A typical CI runner: 4 cores, 16 GB. Memory would allow 8; the CPU allows
    // 3, and 3 is what it was before this change — so CI does not slow down.
    expect(resolveMaxWorkers(4, 16 * GB)).toBe(3);
    expect(resolveMaxWorkers(10, 32 * GB)).toBe(9);
  });

  it("never serialises the suite entirely on a small machine", () => {
    expect(resolveMaxWorkers(2, 2 * GB)).toBe(MIN_WORKERS);
    expect(resolveMaxWorkers(1, 1 * GB)).toBe(MIN_WORKERS);
  });

  it("yields to an explicit override", () => {
    expect(resolveMaxWorkers(8, 8 * GB, { VITEST_MAX_WORKERS: "1" })).toBe(1);
    expect(resolveMaxWorkers(8, 8 * GB, { VITEST_MAX_WORKERS: "" })).toBe(4);
  });
});

describe("the config actually applies the policy", () => {
  it("package.json no longer hardcodes a heap size", async () => {
    // A test of the derived numbers is worth nothing if the scripts stopped
    // using them, which is precisely how the old constant survived the CI fix
    // that removed it from `ci:package`.
    const fs = await import("node:fs");
    const pkg = fs.readFileSync("package.json", "utf8");
    expect(pkg).not.toContain("max-old-space-size");
    for (const script of ["package", "make", "publish"]) {
      expect(JSON.parse(pkg).scripts[script]).toContain(
        "scripts/forge-with-heap.mjs",
      );
    }
  });

  it("vitest.config sets maxWorkers from the resolver", async () => {
    const fs = await import("node:fs");
    const config = fs.readFileSync("vitest.config.mts", "utf8");
    expect(config).toContain("resolveMaxWorkers(");
    expect(config).toContain("maxWorkers: MAX_WORKERS");
  });
});
