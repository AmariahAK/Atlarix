import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

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
  "**/e2e-tests/**",
  "**/scaffold/**",
];

/**
 * Vitest does not read tsconfig `paths` for Vite resolution. Map `@/*` like the app
 * build so unit tests and any Playwright-adjacent imports under `src/` resolve.
 * E2E specs live under `e2e-tests/` and are run by Playwright, not Vitest.
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
          // tests/** belongs to the agent-evals project (real DB + fake LLM).
          exclude: [...sharedExclude, "src/__tests__/renderer/**", "tests/**"],
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
