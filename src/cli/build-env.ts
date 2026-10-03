/**
 * Public configuration the compiled CLI carries (the desktop build embeds the
 * same values with Vite's `define`, vite.main.config.mts MAIN_KEYS): the Supabase
 * project URL and publishable key, the Core proxy URL, the Core model slots.
 *
 * Applied as DEFAULTS, never overrides: a value already in the environment wins,
 * so the cloud agent's own ATLARIX_CORE_PROXY_URL (and local testing) still
 * work. scripts/build-bun.ts fills __ATLARIX_BUILD_ENV__; it holds no secrets.
 */
declare const __ATLARIX_BUILD_ENV__: Record<string, string>;

const embedded: Record<string, string> =
  typeof __ATLARIX_BUILD_ENV__ === "undefined" ? {} : __ATLARIX_BUILD_ENV__;

for (const [key, value] of Object.entries(embedded)) {
  if (value && !process.env[key]) process.env[key] = value;
}
