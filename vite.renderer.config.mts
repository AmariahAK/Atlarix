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
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
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
