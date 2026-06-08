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
          // tests/** belongs to the agent-evals project (real DB + fake LLM).
          exclude: [...sharedExclude, "src/__tests__/renderer/**", "tests/**"],
          // The Blueprint ast-grep tests call `@ast-grep/napi` findInFiles
          // directly; concurrent native callbacks across parallel files can
          // drop a match and yield empty edges (a test-harness concurrency
          // artifact — production scans go through the serialized worker pool).
          // Bounded retry keeps CI deterministic without masking real failures
          // (a genuinely broken test still fails all attempts).
          retry: 2,
        },
      },
      {
        resolve: {
          alias: {
            "@": path.join(root, "src"),
            // jsdom can't load this browser-native package; tests assert
            // around it (the editor module is also vi.mocked in setup).
            "monaco-editor": path.join(
              root,
              "src/__tests__/renderer/stubs/empty-module.ts",
            ),
          },
        },
        test: {
          name: "renderer",
          environment: "jsdom",
          setupFiles: ["./vitest.renderer.setup.ts"],
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
                include: ["tests/agent-evals/**/*.test.ts"],
                exclude: sharedExclude,
                // Real sqlite migrations + streamed fake-LLM turns are slower
                // than pure unit tests; evals drive full agent turns end-to-end.
                testTimeout: 30_000,
                hookTimeout: 30_000,
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
