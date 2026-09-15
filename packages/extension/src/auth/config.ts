/**
 * Build-time configuration, substituted by `scripts/build-extension.mjs`.
 *
 * Declared in `../types/build-define.d.ts` rather than read from `process.env`:
 * there is no `process` here, and a `define` with no matching declaration fails
 * at type-check instead of at runtime — which is the ordering this package
 * wants for everything.
 *
 * Both values are public. The URL is a hostname and the publishable key is
 * designed to ship in clients; RLS is what protects data, not the key's
 * secrecy. The build refuses to substitute an empty string for either, because
 * an extension built with a blank URL installs and opens perfectly and then
 * fails at sign-in with a bare fetch error, ten steps from the mistake.
 */

import type { GoTrueConfig } from "./gotrue";

export const GOTRUE: GoTrueConfig = {
  url: __ATLARIX_SUPABASE_URL__,
  anonKey: __ATLARIX_SUPABASE_ANON_KEY__,
};

export const EXTENSION_VERSION = __ATLARIX_EXTENSION_VERSION__;
