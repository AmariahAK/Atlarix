/**
 * The single gate for crash reporting (Sentry), shared by the build configs and
 * the runtime init paths.
 *
 * The production Sentry project must never hear from a test, QA or dev run. Two
 * layers make that structural rather than a convention:
 *
 *  1. Build time — `sentryDsnForBuild` returns a DSN ONLY for an explicit
 *     release build (`ATLARIX_RELEASE=1`, set by the CI release workflow). A
 *     dev/QA `npm run package` or `build:cli` embeds no DSN, so the packaged
 *     app and the compiled CLI cannot report even when a run crashes
 *     (ATLARIX-47/48/49: a tests-bun scenario and the QA packaged app wrote to
 *     the production project).
 *  2. Init time — `sentryInitAllowed` is false when a harness marks the run
 *     (`ATLARIX_SENTRY_DISABLED=1`, set by the tests-bun preload, the vitest
 *     setup and the e2e scenario harness). That is the belt to the build-time
 *     braces: even a build that somehow carries a DSN reports nothing.
 *
 * This module must stay dependency-free and side-effect-free: the Vite configs
 * and `scripts/build-bun.ts` import it outside the app bundle.
 */

/** Set to "1" by test/QA harnesses to keep crash reporting off for that run. */
export const SENTRY_DISABLED_ENV = "ATLARIX_SENTRY_DISABLED";
/** Set to "1" by the CI release workflow to authorise embedding the DSN. */
export const SENTRY_RELEASE_ENV = "ATLARIX_RELEASE";

/**
 * `process.env` in a Node/Bun context, `{}` in a browser renderer where there
 * is no `process` (renderer.tsx also imports this module). The default argument
 * must not reference `process` directly or the renderer throws on import.
 */
function currentEnv(): Record<string, string | undefined> {
  if (typeof process === "undefined") return {};
  return (process.env as Record<string, string | undefined>) ?? {};
}

/**
 * The DSN a build may embed. Empty unless this is an explicit release build, so
 * dev/QA packaged builds and CLI binaries never carry the production DSN (a
 * leaked DSN is exactly how QA and test runs reached the production project).
 */
export function sentryDsnForBuild(
  env: Record<string, string | undefined> = currentEnv(),
): string {
  if (env[SENTRY_RELEASE_ENV] !== "1") return "";
  return env.SENTRY_DSN || env.ATLARIX_SENTRY_DSN || "";
}

/**
 * Whether crash reporting may run in THIS process. False when a test/QA harness
 * marks the run via `ATLARIX_SENTRY_DISABLED=1`.
 */
export function sentryInitAllowed(
  env: Record<string, string | undefined> = currentEnv(),
): boolean {
  return env[SENTRY_DISABLED_ENV] !== "1";
}
