/**
 * Values substituted at build time by `scripts/build-extension.mjs` via
 * esbuild's `define`, mirroring how `vite.main.config.mts` injects the same
 * credentials into the desktop app.
 *
 * They are DECLARED here rather than read from `process.env` because there is
 * no `process` in an extension, and because a `define` that no declaration
 * matches fails at type-check rather than at runtime — which is the ordering
 * this package wants for everything.
 *
 * WHAT MAY GO IN THIS FILE. Public, client-safe values only: the Supabase URL
 * and the PUBLISHABLE key, both of which are already shipped inside the desktop
 * binary and are meaningless without a user's own JWT. Nothing that grants
 * anything on its own. `vite.main.config.mts` carries the same rule in longer
 * form, including the specific trap that `NEXT_PUBLIC_SUPABASE_SECRET_KEY` is
 * the RLS-bypassing secret despite its prefix.
 */

/** The Supabase project URL, e.g. `https://<ref>.supabase.co`. */
declare const __ATLARIX_SUPABASE_URL__: string;

/** The publishable (anon) key. Public by design; RLS is what protects data. */
declare const __ATLARIX_SUPABASE_ANON_KEY__: string;

/** `manifest.json`'s version, so the UI and any report agree with the package. */
declare const __ATLARIX_EXTENSION_VERSION__: string;

/**
 * A hash of the sources this bundle was built from.
 *
 * The version follows the app's and so does not change between rebuilds of one
 * release; this does. The desktop logs it on connect, which is how a stale
 * extension load is spotted instead of being debugged.
 */
declare const __ATLARIX_BUILD_ID__: string;

/**
 * The Atlarix Core proxy, e.g. `https://…up.railway.app` or `…/v1`.
 *
 * Public — it is a hostname, and the managed PROVIDER keys live on the proxy,
 * never in this bundle. The same value the desktop embeds via
 * `ATLARIX_CORE_PROXY_URL`.
 */
declare const __ATLARIX_CORE_PROXY_URL__: string;
