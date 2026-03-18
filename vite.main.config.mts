import { defineConfig } from "vite";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
try {
  require("dotenv").config();
} catch {
  // dotenv optional
}

// Build-time credentials embedded via Vite define (main process)
const MAIN_KEYS = [
  "AUTH0_DOMAIN",
  "AUTH0_CLIENT_ID",
  "AUTH0_CLIENT_SECRET",
  "AUTH0_AUDIENCE",
  "AUTH0_TOKEN_VAULT_ID",
  "LEMONSQUEEZY_API_KEY",
  "LEMONSQUEEZY_STORE_ID",
  "LEMONSQUEEZY_VARIANT_ID",
  "LEMONSQUEEZY_WORKFORCE_VARIANT_ID",
  "LEMONSQUEEZY_EXTRA_SEAT_VARIANT_ID",
  "LEMONSQUEEZY_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "EMAIL_SOURCE",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
  "SENTRY_DSN",
  "POSTHOG_API_KEY",
] as const;

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: Object.fromEntries(
    MAIN_KEYS.map((k) => [`process.env.${k}`, JSON.stringify(process.env[k] ?? "")])
  ),
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
        "@ai-sdk/mcp",
        // Externalize Babel/recast so @babel/generator's flow/classes submodules initialize in correct order (avoid defineProperty on undefined).
        "recast",
        "ast-types",
        "@babel/parser",
        "@babel/traverse",
        "@babel/generator",
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
