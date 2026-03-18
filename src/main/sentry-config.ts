/**
 * Sentry DSN: set SENTRY_DSN in .env or GitHub Actions secrets.
 * Inlined at build time via Vite define (main process).
 * Optional for local dev; required for CI/production if you want error reporting.
 */
export const SENTRY_DSN = process.env.SENTRY_DSN || undefined;
