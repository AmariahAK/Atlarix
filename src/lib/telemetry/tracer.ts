/**
 * Pass 7.3: OpenTelemetry tracer disabled.
 *
 * `initTelemetry` is now a no-op — the prior implementation pulled in
 * `@opentelemetry/sdk-trace-node`, `@opentelemetry/sdk-trace-base`, and
 * `@opentelemetry/resources`, which inflated the packaged main bundle and
 * caused startup crashes on some macOS builds. Telemetry is no longer
 * initialized; callers (only main.ts) have been updated to drop the call.
 *
 * Stubbed (not deleted) so any residual imports compile and resolve to a
 * benign no-op while the OTEL packages can be removed from package.json
 * in a follow-up cleanup.
 */

export function initTelemetry(): null {
  return null;
}
