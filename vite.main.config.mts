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
  "ATLARIX_CORE_MODEL_1",
  "ATLARIX_CORE_MODEL_2",
  "ATLARIX_CORE_MODEL_3",
  "ATLARIX_CORE_MODEL_4",
  "TEMPLATE_TOKEN",
  "OAUTH_CLIENT_ID",
] as const;

/** Keep in sync with `forge.config.ts` `packageAfterPrune` (named export for fallback + npm install roots). */
export const mainRollupExternals: readonly string[] = [
  // Renderer-only deps must NOT be listed here (e.g. lucide-react, date-fns, posthog-js,
  // react-shiki, shiki / @shikijs/*, core-js) — bundle via renderer Vite, not main externals.
  // WASM / filesystem-relative assets — bundling breaks __dirname (e.g. Missing tiktoken_bg.wasm).
  "@anthropic-ai/tokenizer",
  "tiktoken/lite",
  "tiktoken",
  "unpdf",
  "@vscode/sudo-prompt",
  "better-sqlite3",
  "keytar",
  "mysql2",
  "pg",
  "@lydell/node-pty",
  "@ast-grep/napi",
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
  // v11: @babel/generator and default-shell removed — nothing imports them
  // directly (default-shell is shell-env's transitive dep; npm brings it).
  "shell-env",
];

// https://vitejs.dev/config
export default defineConfig({
  // NO assetsInclude for .sql — conflicts with raw-sql inlining for bundled.generated.ts.
  ssr: {
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
    sourcemap: false,
    // elkjs remains bundled (lazy import). OpenTelemetry is bundled for packaged resolution.
    rollupOptions: {
      external: [...mainRollupExternals],
      // Single main bundle — avoids "Cannot find module './chat_only_handlers-<hash>.js'"
      // when Electron keeps an old main chunk after Vite rebuilds dynamic-import splits.
      output: {
        inlineDynamicImports: true,
      },
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
      /** Dev-only: do not touch stdin during `vite build` / packaging — can break pipes and crash renderer esbuild (`write EPIPE`). */
      apply: "serve",
      closeBundle() {
        process.stdin.emit("data", "rs");
      },
    },
  ],
});
