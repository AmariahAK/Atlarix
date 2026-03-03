/**
 * Sentry DSN: env override for CI/local, fallback for packaged app so errors are reported 24/7.
 */
export const SENTRY_DSN =
  process.env.SENTRY_DSN ||
  "https://0c78796c26225e2c2045851ef0f01fcd@o4510981493882880.ingest.de.sentry.io/4510981520425040";
