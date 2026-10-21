import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { rendererMainOnlyShimsPlugin } from "./vite/renderer-main-only-shims-plugin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

const shims = (name: string) => path.resolve(__dirname, `./src/shims/${name}`);

// https://vite.dev/config/
export default defineConfig({
  plugins: [rendererMainOnlyShimsPlugin(), react(), tailwindcss()],
  /** Modern Chromium (Electron): less downlevel work for esbuild during large renderer bundles. */
  esbuild: {
    target: "es2022",
    logLimit: 0,
  },
  /** Keep UI deps bundled into renderer chunks — do not externalize (would leave loose node_modules in ASAR). */
  build: {
    target: "es2022",
    // As main: hidden maps for the Sentry upload only, never shipped (forge.config.ts).
    sourcemap: process.env.ATLARIX_SOURCEMAPS === "1" ? "hidden" : false,
    reportCompressedSize: false,
    /** Keep `?url` SVG imports as files — inline data URLs break in packaged Electron. */
    assetsInlineLimit: 0,
    rollupOptions: {
      external: [],
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/echarts")) return "vendor-echarts";
          if (
            id.includes("node_modules/shiki") ||
            id.includes("node_modules/@shikijs")
          ) {
            return "vendor-shiki";
          }
        },
      },
    },
  },
  resolve: {
    /**
     * Specific `@/…` aliases MUST come before `{ find: "@", … }` or Vite resolves
     * `@/lib/models_dev` as `src` + `/lib/models_dev` (real main-only file).
     */
    alias: [
      {
        find: "@/lib/models_dev",
        replacement: shims("models-dev-renderer-stub.ts"),
      },
      {
        find: "@/lib/auth/supabase-secure-storage",
        replacement: shims("supabase-secure-storage-renderer-stub.ts"),
      },
      {
        find: "@/lib/auth/supabase-client",
        replacement: shims("supabase-client-renderer-stub.ts"),
      },
      { find: "@/ipc/utils/read_env", replacement: shims("read-env-stub.ts") },
      /** get_model_client pulls provider SDKs (google-vertex → gaxios) the renderer can't bundle. */
      {
        find: "@/ipc/utils/get_model_client",
        replacement: shims("get-model-client-renderer-stub.ts"),
      },
      /** Do not alias `@/db` — it prefix-matches `@/db/schema`. DB stub is via resolve plugin (db/index only). */
      {
        find: "@/main/settings",
        replacement: shims("main-settings-renderer-stub.ts"),
      },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      {
        find: "@sentry/electron/main",
        replacement: shims("sentry-electron-main-stub.ts"),
      },
      { find: "shell-env", replacement: shims("shell-env-stub.ts") },
      { find: "default-shell", replacement: shims("default-shell-stub.ts") },
    ],
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
    ]),
  ),
});
