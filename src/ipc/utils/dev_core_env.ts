/**
 * DEV-ONLY Atlarix Core credentials.
 *
 * In a signed/packaged release the Core master key is embedded by Vite `define`
 * from CI secrets (see `compass_constants.ts`). A local `npm run package` build
 * has NO embedded key, so the Core auto-fallback can never be exercised locally.
 *
 * This module lets a developer exercise Core (and the auto-fallback) by reading
 * `COMPASS_OPENROUTER_API_KEY` / `ATLARIX_CORE_MODEL_1..4` from the local shell
 * env — but ONLY in an unpackaged / `NODE_ENV=development` build. In a packaged
 * release `app.isPackaged === true`, so every getter returns `undefined` and
 * release behavior is byte-identical. It is wired into `compass_constants.ts`
 * via `__setDevCoreKeyProvider` from the main bootstrap (`main.ts`); the default
 * provider there is a no-op, so renderer/headless contexts are unaffected.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { getEnvVar } from "./read_env";
import {
  CORE_TIER_1,
  CORE_TIER_2,
  CORE_TIER_3,
  CORE_TIER_4,
} from "../shared/compass_constants";

const requireElectron = createRequire(
  typeof import.meta.url === "string"
    ? import.meta.url
    : path.join(__dirname, "dev_core_env.js"),
);

let cachedIsDev: boolean | undefined;

/** True only for an unpackaged / development build. Cached after first call. */
function isDevBuild(): boolean {
  if (cachedIsDev !== undefined) return cachedIsDev;
  if (process.env.NODE_ENV === "development") {
    cachedIsDev = true;
    return true;
  }
  // Lazy-require electron so headless/tsx bench builds (no electron) don't throw.
  try {
    const electron = requireElectron("electron") as typeof import("electron");
    cachedIsDev = electron.app ? !electron.app.isPackaged : false;
  } catch {
    cachedIsDev = false;
  }
  return cachedIsDev;
}

function readDevEnv(name: string): string | undefined {
  if (!isDevBuild()) return undefined;
  const v = getEnvVar(name);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Local-shell Core master key (dev/unpackaged only); `undefined` in release. */
export function getDevCoreApiKey(): string | undefined {
  return readDevEnv("COMPASS_OPENROUTER_API_KEY");
}

const TIER_ENV: Record<string, string> = {
  [CORE_TIER_1]: "ATLARIX_CORE_MODEL_1",
  [CORE_TIER_2]: "ATLARIX_CORE_MODEL_2",
  [CORE_TIER_3]: "ATLARIX_CORE_MODEL_3",
  [CORE_TIER_4]: "ATLARIX_CORE_MODEL_4",
};

/** Local-shell OpenRouter model id for a Core tier (dev/unpackaged only). */
export function getDevCoreModelId(tier: string): string | undefined {
  const envName = TIER_ENV[tier];
  return envName ? readDevEnv(envName) : undefined;
}

/** @internal Tests — reset the dev/packaged determination cache. */
export function __resetDevCoreCacheForTests(): void {
  cachedIsDev = undefined;
}
