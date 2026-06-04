/**
 * Renderer build: redirect main-process-only modules to stubs.
 * Catches relative imports (e.g. `./supabase-secure-storage`) that bypass `@/` aliases.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const SHIMS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/shims",
);

const STUB_FILES = {
  modelsDev: "models-dev-renderer-stub.ts",
  supabaseClient: "supabase-client-renderer-stub.ts",
  supabaseSecureStorage: "supabase-secure-storage-renderer-stub.ts",
  subscriptionManager: "subscription-manager-renderer-stub.ts",
  db: "db-renderer-stub.ts",
  readEnv: "read-env-stub.ts",
  mainSettings: "main-settings-renderer-stub.ts",
} as const;

function stubPath(file: string): string {
  return path.join(SHIMS_DIR, file);
}

function normalizeId(id: string): string {
  return id.replace(/\\/g, "/");
}

function isShimPath(id: string): boolean {
  return id.includes("/shims/") || id.includes("-renderer-stub");
}

/** Map a resolved filesystem path or import specifier to a renderer stub, if applicable. */
function shimForModuleId(id: string): string | null {
  const n = normalizeId(id);
  if (isShimPath(n)) return null;
  // Drizzle schema is types/tables only — keep the real module in the renderer bundle.
  if (/[/\\]db[/\\]schema(\.ts)?$/.test(n)) return null;

  if (/[/\\]supabase-secure-storage(\.ts)?$/.test(n)) {
    return stubPath(STUB_FILES.supabaseSecureStorage);
  }
  if (/[/\\]supabase-client(\.ts)?$/.test(n)) {
    return stubPath(STUB_FILES.supabaseClient);
  }
  if (/[/\\]models_dev(\.ts)?$/.test(n)) {
    return stubPath(STUB_FILES.modelsDev);
  }
  if (/[/\\]SubscriptionManager(\.ts)?$/.test(n)) {
    return stubPath(STUB_FILES.subscriptionManager);
  }
  if (
    /[/\\]db[/\\]index(\.ts)?$/.test(n) ||
    /[/\\]src[/\\]db\.ts$/.test(n) ||
    /[/\\]src[/\\]db$/.test(n)
  ) {
    return stubPath(STUB_FILES.db);
  }
  if (/[/\\]read_env(\.ts)?$/.test(n)) {
    return stubPath(STUB_FILES.readEnv);
  }
  if (/[/\\]main[/\\]settings(\.ts)?$/.test(n)) {
    return stubPath(STUB_FILES.mainSettings);
  }

  if (
    /^@ast-grep\/napi(-darwin-arm64|-darwin-x64|-win32-x64-msvc|-win32-arm64-msvc|-linux-x64-gnu|-linux-arm64-gnu)?$/.test(
      n,
    ) ||
    n.includes("@ast-grep/napi") ||
    n.includes("@ast-grep/lang-python") ||
    n.includes("@ast-grep/lang-go")
  ) {
    return path.join(SHIMS_DIR, "ast-grep-napi-renderer-stub.ts");
  }

  return null;
}

function candidatePaths(source: string, importer?: string): string[] {
  const out = [source];
  if (!importer) return out;
  if (source.startsWith(".") || source.startsWith("/")) {
    const base = path.dirname(importer);
    const joined = path.normalize(path.join(base, source));
    out.push(joined, `${joined}.ts`, path.join(joined, "index.ts"));
  }
  return out;
}

export function rendererMainOnlyShimsPlugin(): Plugin {
  return {
    name: "renderer-main-only-shims",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "@/db") {
        return stubPath(STUB_FILES.db);
      }
      if (source === "path" || source === "node:path") {
        return stubPath("path-renderer-stub.ts");
      }
      if (
        source === "@ast-grep/napi" ||
        source.startsWith("@ast-grep/napi-") ||
        source === "@ast-grep/lang-python" ||
        source === "@ast-grep/lang-go"
      ) {
        return path.join(SHIMS_DIR, "ast-grep-napi-renderer-stub.ts");
      }
      for (const candidate of candidatePaths(source, importer)) {
        const shim = shimForModuleId(candidate);
        if (shim) return shim;
      }
      return null;
    },
  };
}
