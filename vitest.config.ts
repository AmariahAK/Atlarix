import path from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

/**
 * Vitest does not read tsconfig `paths` for Vite resolution. Map `@/*` like the app
 * build so unit tests and any Playwright-adjacent imports under `src/` resolve.
 * E2E specs live under `e2e-tests/` and are run by Playwright, not Vitest.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.join(root, "src"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "**/e2e-tests/**",
      "**/scaffold/**",
    ],
  },
});
