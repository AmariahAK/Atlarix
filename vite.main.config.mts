import { defineConfig } from "vite";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
try {
  require("dotenv").config();
} catch {
  // dotenv optional
}

// Build-time values embedded via Vite define (main process).
// SERVER SECRETS ARE NOT PERMITTED HERE — anything in this list ships inside the
// packaged binary and is extractable by any user. The following were removed and
// moved server-side (Supabase edge functions / atlarix-proxy):
//   COMPASS_OPENROUTER_API_KEY (SB-02/06 → atlarix-proxy)
//   LEMONSQUEEZY_API_KEY       (A2 → create-checkout / cancel-subscription edge fns)
//   LEMONSQUEEZY_WEBHOOK_SECRET(A1 → only the webhook function needs it)
//   RESEND_API_KEY             (A3 → send-email edge fn)
const MAIN_KEYS = [
  "LEMONSQUEEZY_STORE_ID",
  "LEMONSQUEEZY_VARIANT_ID",
  "LEMONSQUEEZY_CREDIT_VARIANT_ID",
  "EMAIL_SOURCE",
  "NEXT_PUBLIC_SUPABASE_URL",
  // NEXT_PUBLIC_SUPABASE_ANON_KEY removed — migrated to the publishable key below.
  // NEVER add NEXT_PUBLIC_SUPABASE_SECRET_KEY here: despite the NEXT_PUBLIC_ prefix
  // it is the RLS-bypassing SECRET key and must never ship in the client bundle.
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
  "SENTRY_DSN",
  "POSTHOG_API_KEY",
  // COMPASS_OPENROUTER_API_KEY intentionally REMOVED — the managed key must never
  // ship in the client (SB-02/06). Core routes through atlarix-proxy instead; the
  // client only needs the public proxy URL below.
  "ATLARIX_CORE_PROXY_URL",
  "ATLARIX_CORE_PROXY_FALLBACK_URL",
  "ATLARIX_CORE_MODEL_1",
  "ATLARIX_CORE_MODEL_2",
  "ATLARIX_CORE_MODEL_3",
  "ATLARIX_CORE_MODEL_4",
  "TEMPLATE_TOKEN",
] as const;

/** Keep in sync with `forge.config.ts` `packageAfterPrune` (named export for fallback + npm install roots). */
export const mainRollupExternals: readonly string[] = [
  // Renderer-only deps must NOT be listed here (e.g. lucide-react, date-fns, posthog-js,
  // react-shiki, shiki / @shikijs/*, core-js) — bundle via renderer Vite, not main externals.
  // WASM / filesystem-relative assets — bundling breaks __dirname (e.g. Missing tiktoken_bg.wasm).
  "@anthropic-ai/tokenizer",
  "tiktoken/lite",
  "tiktoken",
  // The QuickJS engine mods run in (lib/plugins/mod-host.ts). Its ES-module
  // entry reads `import.meta.url` when it loads, which this CommonJS bundle does
  // not have, so a bundled copy threw before the .wasm was ever used (QA 1 A6:
  // every mod off in the packaged app). External, Node loads the package's
  // CommonJS build; packageAfterPrune installs it. The .wasm bytes still come
  // from Resources/emscripten-module.wasm.
  "quickjs-emscripten-core",
  "@jitl/quickjs-wasmfile-release-sync",
  "unpdf",
  "@vscode/sudo-prompt",
  // Bundled ripgrep binary (grep/glob) — external so the binary resolves from
  // node_modules at runtime and ships unpacked (see forge asar.unpack). Makes
  // the app self-contained instead of relying on `rg` being on the user's PATH.
  "@vscode/ripgrep",
  "better-sqlite3",
  // node-cron FORKS a sibling `daemon.js`, locating it with `import.meta.url` —
  // a file lookup that can never work from inside a bundle, let alone an asar.
  // It also crashed the packaged app outright under Vite 8: node-cron publishes
  // both `import` and `require` conditions, Vite 5 took the CJS one (which uses
  // `__dirname`), and Vite 8 takes the ESM one and compiles `import.meta.url`
  // down to `{}.url` — i.e. `undefined` — in a CJS build. Two UNGUARDED
  // top-level `fileURLToPath(undefined)` calls, so the main process died before
  // any window appeared ("A JavaScript error occurred in the main process").
  //
  // Other bundled packages hit the same transform but all guard it
  // (`typeof {}.url === "string" ? … : __dirname`), which is why only this one
  // was fatal. Externalising is the right fix regardless of Vite version: it is
  // a runtime dependency with a side file it must resolve on disk.
  "node-cron",
  "keytar",
  "mysql2",
  "pg",
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
  // v11: @babel/generator and default-shell removed — nothing imports them
  // directly (default-shell is shell-env's transitive dep; npm brings it).
  "shell-env",
  // Runtime externals that Rollup leaves as bare require()s but which were NOT
  // listed here — so packageAfterPrune never installed them (or the slimming
  // pruned them) and the packaged app crashed at boot with "Cannot find module".
  // These must ALSO be listed in package.json dependencies so they survive the
  // staged-package.json slimming (keepRoots ∩ fullDeps). domino is turndown's
  // HTML→Markdown DOM; axios/bluebird are transitive requires left external.
  // NOTE: electron-log must stay BUNDLED here (not external) — externalizing it
  // makes it initialize twice and re-register its __ELECTRON_LOG__ IPC handler,
  // crashing the main process at boot.
  "@mixmark-io/domino",
  "axios",
  "bluebird",
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
    MAIN_KEYS.map((k) => [
      `process.env.${k}`,
      JSON.stringify(process.env[k] ?? ""),
    ]),
  ),
  build: {
    // "hidden": maps written beside the bundle for the release to upload to Sentry,
    // with no reference in the shipped code. packageAfterPrune (forge.config.ts)
    // deletes them from the app; only set when the release has a Sentry token.
    sourcemap: process.env.ATLARIX_SOURCEMAPS === "1" ? "hidden" : false,
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
