import path from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

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
      {
        resolve: {
          alias: {
            "@": path.join(root, "src"),
            // Root better-sqlite3 is rebuilt for Electron's ABI (postinstall
            // electron-rebuild); plain-Node vitest needs the Node-ABI copy
            // installed under tests/infra (see tests/infra/package.json).
            "better-sqlite3": path.join(
              root,
              "tests/infra/node_modules/better-sqlite3",
            ),
          },
        },
        test: {
          name: "agent-evals",
          environment: "node",
          setupFiles: [
            "./vitest.setup.ts",
            "./tests/infra/setup-agent-evals.ts",
          ],
          include: ["tests/agent-evals/**/*.test.ts"],
          exclude: sharedExclude,
          // Real sqlite migrations + streamed fake-LLM turns are slower than
          // pure unit tests; evals drive full agent turns end-to-end.
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // Each eval file owns a real DB singleton + temp dirs; keep files
          // isolated from each other.
          fileParallelism: false,
        },
      },
    ],
  },
});
