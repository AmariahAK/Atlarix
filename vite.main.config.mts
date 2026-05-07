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
  "COMPASS_OPENROUTER_API_KEY",
  "COMPASS_MODEL_FAST",
  "COMPASS_MODEL_BALANCED",
  "COMPASS_MODEL_THINKING",
  "GROQ_CLASSIFIER_API_KEY",
  "GROQ_CLASSIFIER_MODEL",
  "TEMPLATE_TOKEN",
] as const;

/** Keep in sync with `forge.config.ts` `packageAfterPrune` (named export for fallback + npm install roots). */
export const mainRollupExternals: readonly string[] = [
  // WASM / filesystem-relative assets — bundling breaks __dirname (e.g. Missing tiktoken_bg.wasm).
  "@anthropic-ai/tokenizer",
  "tiktoken/lite",
  "tiktoken",
  // pdfjs: worker + standard_fonts + wasm resolved via require/import from real package dir (attachment-tools).
  "pdfjs-dist",
  "better-sqlite3",
  "keytar",
  "tree-sitter",
  "tree-sitter-typescript",
  "tree-sitter-javascript",
  "tree-sitter-python",
  "mysql2",
  "@lydell/node-pty",
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
  "recast",
  "ast-types",
  "@babel/parser",
  "@babel/traverse",
  "@babel/generator",
];

// https://vitejs.dev/config
export default defineConfig({
  // NO assetsInclude for .sql — conflicts with raw-sql inlining for bundled.generated.ts.
  ssr: {
    noExternal: [],
    external: [...mainRollupExternals],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: Object.fromEntries(
    MAIN_KEYS.map((k) => [`process.env.${k}`, JSON.stringify(process.env[k] ?? "")])
  ),
  build: {
    // elkjs remains bundled (lazy import). OpenTelemetry is bundled for packaged resolution.
    rollupOptions: {
      external: [...mainRollupExternals],
    },
  },
  plugins: [
    {
      name: "raw-sql",
      enforce: "pre",
      transform(code, id) {
        if (!id.endsWith(".sql")) return null;
        return {
          code: `export default ${JSON.stringify(code)}`,
          map: null,
        };
      },
    },
    {
      name: "restart",
      closeBundle() {
        process.stdin.emit("data", "rs");
      },
    },
  ],
});
