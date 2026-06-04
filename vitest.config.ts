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
          exclude: [...sharedExclude, "src/__tests__/renderer/**"],
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
    ],
  },
});
