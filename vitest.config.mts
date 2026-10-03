import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { resolveMaxWorkers } from "./scripts/lib/machine-limits.mjs";

const root = import.meta.dirname;

/**
 * How many suites may run at once.
 *
 * Vitest's default is `ncpu - 1` FORKED processes, each a full Node with its own
 * V8 heap, and several of these projects boot jsdom on top of that. It sizes
 * itself to the CPU and never looks at the RAM — fine on a build server, not
 * fine on a laptop.
 *
 * Measured here on an 8 GB / 8-logical-core MacBook Air: the default 7 workers
 * against 560 suites drove the machine to 4% free memory and 39.7 GB of swap,
 * with `kernel_task` at 151% CPU — macOS throttling a thrashing system. Every
 * app lagged and it ended in a hard restart. The CPU count said 7 was
 * reasonable; the 8 GB of RAM said it was not.
 *
 *   8 GB  /  8 cores  →  4 workers   (was 7 — the setting that crashed it)
 *   16 GB /  4 cores  →  3 workers   (CI unchanged; CPU is still binding)
 *   32 GB / 10 cores  →  9 workers   (unchanged)
 *
 * The policy lives in `scripts/lib/machine-limits.mjs` so the packaging heap and
 * this share one definition of "how much of the machine may we take", and so it
 * can be tested against machine shapes nobody here owns.
 */
const MAX_WORKERS = resolveMaxWorkers(
  os.cpus().length,
  os.totalmem(),
  process.env,
);

/**
 * The agent-evals project aliases `better-sqlite3` to a Node-ABI copy under
 * tests/infra/node_modules (the root copy is rebuilt for Electron's ABI). That
 * copy is a local-only install (gitignored), so if it isn't present — e.g. a CI
 * job that didn't run `npm install --prefix tests/infra`, or a fresh clone —
 * skip registering the project entirely instead of failing every suite to load
 * with an unresolved-alias error.
 */
const AGENT_EVALS_BETTER_SQLITE = path.join(
  root,
  "tests/infra/node_modules/better-sqlite3",
);
// Require the compiled native binary, not just the package dir — a partial
// install (dir present, prebuild fetch failed) would otherwise register the
// project and then fail every suite at load with an ABI/require error.
const AGENT_EVALS_READY = fs.existsSync(
  path.join(AGENT_EVALS_BETTER_SQLITE, "build/Release/better_sqlite3.node"),
);
if (!AGENT_EVALS_READY) {
  console.warn(
    "[vitest] agent-evals project skipped: tests/infra Node-ABI better-sqlite3 not built (run `npm install --prefix tests/infra`).",
  );
}

/**
 * Explicit timeout for the unit projects.
 *
 * They had none, so they inherited vitest's 5,000 ms default — and that stopped
 * being generous a while ago. Measured 2026-08-05 on an idle machine, the
 * slowest `node` test (`subagent-proposals`) runs **2,592 ms**: already past half
 * the budget with nothing else competing. Several others sit in the same band
 * because they `await import()` modules that pull in native bindings and
 * migrations.
 *
 * The failure mode is not a slow test, it is a MISLEADING one. Two full-suite
 * runs that day shared the machine with a `tsc --noEmit` and produced 4 and then
 * 8 "Test timed out in 5000ms" failures across `spawn-task`, `subagent-*`,
 * `cancel-preserves-revert`, `stop-and-revert-integrity` and
 * `active-skill-truncation` — every one of which passes in isolation. A CI
 * runner is exactly that environment, and a suite that fails differently
 * depending on what else the box is doing teaches people to re-run red builds
 * instead of reading them. (This is the v14.23.0 timeout trap resurfacing as a
 * margin problem rather than a Windows-only one.)
 *
 * 30s is ~11x the slowest real test — room for a loaded runner without being so
 * long that a genuinely hung test stops looking hung. `agent-evals` keeps its own
 * 90s for the separate reason documented at its project.
 */
const UNIT_TEST_TIMEOUT_MS = 30_000;

const sharedExclude = [
  "**/node_modules/**",
  "**/dist/**",
  "**/cypress/**",
  "**/.{idea,git,cache,output,temp}/**",
  "**/{karma,rollup,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
  "**/scaffold/**",
];

/**
 * Vitest does not read tsconfig `paths` for Vite resolution. Map `@/*` like the app
 * build so unit tests resolve the same way the app does.
 *
 * v10.1: multi-project — the original node project for unit/main-process tests,
 * plus a jsdom project for renderer/component tests under `src/__tests__/renderer/`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.join(root, "src"),
    },
  },
  test: {
    // Applies to every project below; each one may still override it.
    maxWorkers: MAX_WORKERS,
    projects: [
      {
        resolve: {
          alias: { "@": path.join(root, "src") },
        },
        test: {
          name: "node",
          environment: "node",
          setupFiles: ["./vitest.setup.ts"],
          testTimeout: UNIT_TEST_TIMEOUT_MS,
          hookTimeout: UNIT_TEST_TIMEOUT_MS,
          // tests/** belongs to the agent-evals project (real DB + fake LLM),
          // and packages/** to the extension project. That last exclusion is
          // load-bearing, not tidiness: this project gives a suite Node's
          // globals, so an extension module that reached for `process` or a
          // node: builtin would pass HERE and fail in a real browser — which is
          // the exact isolation the extension project exists to enforce.
          exclude: [
            ...sharedExclude,
            "src/__tests__/renderer/**",
            "tests/**",
            "packages/**",
            // Run by `bun test` (they import bun:sqlite), never by vitest.
            "tests-bun/**",
          ],
        },
      },
      {
        resolve: {
          alias: {
            "@": path.join(root, "src"),
          },
        },
        test: {
          name: "renderer",
          environment: "jsdom",
          setupFiles: ["./vitest.renderer.setup.ts"],
          testTimeout: UNIT_TEST_TIMEOUT_MS,
          hookTimeout: UNIT_TEST_TIMEOUT_MS,
          include: ["src/__tests__/renderer/**/*.test.{ts,tsx}"],
          exclude: sharedExclude,
        },
      },
      {
        // The extension's portable half — the permission classifier, site
        // grants, PKCE, capability probing. jsdom because several of these
        // inspect DOM-shaped input, and because the page-realm scripts they
        // share with the app need a document.
        //
        // It is a separate project rather than more files under src/__tests__
        // for the same reason the package has its own tsconfig: these modules
        // must never see Node or Electron globals, and a project that cannot
        // resolve them is the cheapest way to guarantee it.
        resolve: {
          alias: { "@": path.join(root, "src") },
        },
        // `scripts/build-extension.mjs` substitutes these, and `config.ts`
        // reads them as bare globals — deliberately, so a missing one fails at
        // type-check rather than becoming an empty string that only surfaces as
        // a bare fetch error at sign-in. Vitest is a build too, so it has to
        // supply them or every module importing config.ts dies with a
        // ReferenceError. Obvious placeholders: a test that needs a REAL
        // project is an integration test and does not belong in this project.
        define: {
          __ATLARIX_SUPABASE_URL__: JSON.stringify("https://test.supabase.co"),
          __ATLARIX_SUPABASE_ANON_KEY__: JSON.stringify("test-anon-key"),
          __ATLARIX_EXTENSION_VERSION__: JSON.stringify("0.0.0-test"),
          __ATLARIX_CORE_PROXY_URL__: JSON.stringify("https://proxy.test/v1"),
        },
        test: {
          name: "extension",
          environment: "jsdom",
          // jsdom has no `CSS` at all. The renderer project gets one for free
          // from `@testing-library/jest-dom`; this project imports nothing, so
          // code that correctly escapes a selector would fail here and pass in
          // every real browser. See the file for the other jsdom gaps.
          setupFiles: ["./vitest.extension.setup.ts"],
          testTimeout: UNIT_TEST_TIMEOUT_MS,
          hookTimeout: UNIT_TEST_TIMEOUT_MS,
          include: ["packages/extension/src/**/*.test.ts"],
          exclude: sharedExclude,
        },
      },
      ...(AGENT_EVALS_READY
        ? [
            {
              resolve: {
                alias: {
                  "@": path.join(root, "src"),
                  // Root better-sqlite3 is rebuilt for Electron's ABI (postinstall
                  // electron-rebuild); plain-Node vitest needs the Node-ABI copy
                  // installed under tests/infra (see tests/infra/package.json).
                  "better-sqlite3": AGENT_EVALS_BETTER_SQLITE,
                },
              },
              test: {
                name: "agent-evals",
                environment: "node" as const,
                setupFiles: [
                  "./vitest.setup.ts",
                  "./tests/infra/setup-agent-evals.ts",
                ],
                include: [
                  "tests/agent-evals/**/*.test.ts",
                  // The SWE-bench runner + its smoke test reuse the same
                  // in-process harness (real DB + agent loop).
                  "tests/bench/**/*.test.ts",
                ],
                exclude: sharedExclude,
                // Real sqlite migrations + streamed fake-LLM turns are slower
                // than pure unit tests; evals drive full agent turns end-to-end.
                //
                // Must stay comfortably ABOVE AGENT_TURN_TIMEOUT_MS
                // (tests/infra/ipc.ts). At 30s it exactly matched the inner
                // waitFor budget, so the two raced: vitest winning reports a
                // bare "test timed out" and throws away the helper's far more
                // useful "Recorded channels: …" diagnosis.
                testTimeout: 90_000,
                hookTimeout: 90_000,
                // Each eval file owns a real DB singleton + temp dirs; keep
                // files isolated from each other.
                fileParallelism: false,
              },
            },
          ]
        : []),
    ],
  },
});
