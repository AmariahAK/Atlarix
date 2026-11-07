/**
 * A turn on the user's own provider (a key, a provider they added, a local
 * model) that failed, reported to Sentry. Before this, only Core's own
 * infrastructure errors were captured, so a provider that broke for every
 * BYOK user (a request it rejects, an endpoint that changed) was invisible.
 *
 * What is sent is the fixed failure word and status, and tags saying where:
 * billing, provider type, model, surface, editor. Never the error's text (a
 * provider can quote the prompt back) and never a key. Like every crash
 * report it is not covered by the analytics answer (the consent text says so),
 * and the usual scrubbers still run on it.
 *
 * Failures the user causes or that are expected are not reported: a refused
 * key, an empty balance, a rate limit, a too-long thread (compaction retries
 * it), content the provider refuses on policy, no folder open.
 */
import { atlarixEditor, atlarixSurface } from "@/ipc/shared/core_proxy";
import { billingOf, providerFields } from "@/main/lib/analytics";
import type { TurnEnd, TurnErrorKind } from "@/lib/analytics/turn-end";

const EXPECTED: ReadonlySet<TurnErrorKind> = new Set<TurnErrorKind>([
  "auth",
  "quota",
  "consent_required",
  "rate_limit",
  "context_overflow",
  "content_rejected",
  "no_workspace",
]);

/** Named so Sentry groups these apart from crashes. */
export class TurnFailedError extends Error {
  override name = "TurnFailed";
}

export interface TurnFailure {
  end: TurnEnd;
  provider?: string;
  model?: string;
  fellBackToCore?: boolean;
}

type Capture = (error: unknown, ctx: { tags: Record<string, string>; fingerprint?: string[] }) => void;

/** True when this turn's failure is one Sentry should hear about. */
export function isReportableTurnFailure(f: TurnFailure): boolean {
  if (f.end.outcome !== "error" || !f.provider || f.fellBackToCore) return false;
  // Core's failures are reported where they happen (simple-stream-text) and by the proxy.
  if (f.provider === "compass") return false;
  return !EXPECTED.has(f.end.errorKind ?? "other");
}

export function reportTurnFailure(
  f: TurnFailure,
  capture: Capture,
  providerTypeOf?: (providerId: string) => Promise<{ type?: string; apiFormat?: string } | undefined>,
): void {
  try {
    if (!isReportableTurnFailure(f)) return;
    void (async () => {
      const looked = await providerTypeOf?.(f.provider!).catch(() => undefined);
      const { provider_type } = providerFields(f.provider!, looked?.type, looked?.apiFormat);
      const kind = f.end.errorKind ?? "other";
      const editor = atlarixEditor();
      capture(new TurnFailedError(`${kind} (${provider_type})`), {
        tags: {
          billing: billingOf(f.provider!, looked?.type),
          provider_type,
          ...(f.model ? { model: f.model.slice(0, 120) } : {}),
          surface: atlarixSurface(),
          ...(editor ? { editor } : {}),
          error_kind: kind,
          ...(f.end.httpStatus ? { http_status: String(f.end.httpStatus) } : {}),
          // The provider's machine code (allowlisted in turn-end.ts), never its text.
          ...(f.end.providerCode ? { provider_code: f.end.providerCode } : {}),
        },
        fingerprint: ["turn-failed", kind, provider_type],
      });
    })().catch(() => {});
  } catch {
    /* reporting must never break the turn */
  }
}

/** The same tags on a Core turn's own error report (simple-stream-text). */
export function coreTurnTags(model: string | undefined): Record<string, string> {
  const editor = atlarixEditor();
  return {
    billing: "core",
    provider_type: "compass",
    ...(model ? { model: model.slice(0, 120) } : {}),
    surface: atlarixSurface(),
    ...(editor ? { editor } : {}),
  };
}
