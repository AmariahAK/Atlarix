import path from "path";
import { createRequire } from "module";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const require = createRequire(import.meta.url);
try {
  require("dotenv").config();
} catch {
  // dotenv optional
}

const RENDERER_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
  "POSTHOG_API_KEY",
  "SENTRY_DSN",
] as const;

// https://vite.dev/config/
export default defineConfig({
  /** RTE pulls oxc-parse transitively; without this, resolve uses oxc's "browser" → wasm (fails in UI bundle). */
  optimizeDeps: {
    exclude: ["oxc-parser"],
  },
  plugins: [react(), tailwindcss()],
  /** Modern Chromium (Electron): less downlevel work for esbuild during large renderer bundles. */
  esbuild: {
    target: "es2022",
    logLimit: 0,
  },
  /** Keep UI deps bundled into renderer chunks — do not externalize (would leave loose node_modules in ASAR). */
  build: {
    target: "es2022",
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      external: [],
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/mermaid")) return "vendor-mermaid";
          if (id.includes("node_modules/shiki") || id.includes("node_modules/@shikijs")) {
            return "vendor-shiki";
          }
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "oxc-parser": path.resolve(__dirname, "./src/shims/oxc-parser-renderer-stub.ts"),
      /**
       * `guard.ts` (pulled in via `ToolRegistry`) dynamically imports `@sentry/electron/main`.
       * In the renderer graph that would bundle `@sentry/node` and fail (Node `util`, `url`, …).
       */
      "@sentry/electron/main": path.resolve(
        __dirname,
        "./src/shims/sentry-electron-main-stub.ts",
      ),
    },
  },
  server: {
    watch: {
      // The Electron main process writes runtime state under ./userData in dev.
      // If Vite watches it, it triggers infinite reload loops (diagram git tracker snapshots, etc.).
      ignored: ["**/userData/**"],
    },
  },
  define: Object.fromEntries(
    RENDERER_KEYS.map((k) => [
      `import.meta.env.${k}`,
      JSON.stringify(process.env[k] ?? ""),
    ])
  ),
});
