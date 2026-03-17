import { defineConfig } from "vite";
import path from "path";

// Embed build-time env into main process bundle so packaged app has config without .env.
// CI passes these via job env (GitHub Actions repository secrets).
const envKeys = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
  "SENTRY_DSN",
  "POSTHOG_API_KEY",
  "RESEND_API_KEY",
  "EMAIL_SOURCE",
] as const;
const define: Record<string, string> = {};
for (const key of envKeys) {
  const val = process.env[key];
  define[`process.env.${key}`] = JSON.stringify(val ?? "");
}

// https://vitejs.dev/config
export default defineConfig({
  define,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      external: [
        "better-sqlite3",
        "mysql2",
        // elkjs is bundled (use main entry 'elkjs' in code so it bundles without defineProperty issues).
        // OpenTelemetry packages are bundled so the packaged app finds them (no runtime require from node_modules).
        // Externalize AI SDK packages to avoid "Object.defineProperty called on non-object" when bundled (flow/node exports interop).
        "ai",
        "@ai-sdk/provider",
        "@ai-sdk/openai",
        "@ai-sdk/anthropic",
        "@ai-sdk/google",
        "@ai-sdk/google-vertex",
        "@ai-sdk/azure",
        "@ai-sdk/xai",
        "@ai-sdk/amazon-bedrock",
        "@ai-sdk/openai-compatible",
        "@ai-sdk/provider-utils",
      ],
    },
  },
  plugins: [
    {
      name: "restart",
      closeBundle() {
        process.stdin.emit("data", "rs");
      },
    },
  ],
});
