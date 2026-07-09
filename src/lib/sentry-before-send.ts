import type { ErrorEvent, EventHint } from "@sentry/core";
import { isPlanLimitError } from "@/lib/plan-limit-error";
import { sentryMessageMatchesIgnoredPattern } from "@/lib/sentry-ignore-patterns";
import { normalizeSentryErrorText } from "@/lib/sentry-decode-message";
import { isNoUsableModelOutputError } from "@/ipc/utils/no_usable_model_output";
import {
  isStreamStopAbort,
  textHasStreamStopSentinel,
} from "@/lib/stream/stream-stop-sentinels";
import { redactSecretsInText } from "@/lib/security/redact-secrets";

/**
 * A15/M-8: scrub high-confidence secret shapes from every field we transmit —
 * message, exception values, request URL, and breadcrumb message/data — before
 * the event leaves the process. `beforeSend` previously only DROPPED expected
 * errors; it performed no redaction, so a key/token in an exception message or a
 * fetch-error URL was sent to Sentry verbatim.
 */
function redactEventSecrets(event: ErrorEvent): ErrorEvent {
  if (event.message) event.message = redactSecretsInText(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = redactSecretsInText(ex.value);
  }
  if (event.request?.url) {
    event.request.url = redactSecretsInText(event.request.url);
  }
  for (const bc of event.breadcrumbs ?? []) {
    if (bc.message) bc.message = redactSecretsInText(bc.message);
    if (bc.data) {
      for (const k of Object.keys(bc.data)) {
        const v = bc.data[k];
        if (typeof v === "string") bc.data[k] = redactSecretsInText(v);
      }
    }
  }
  return event;
}

/**
 * Drop expected non-errors so Sentry alerts stay actionable.
 * - Auth required, plan/workspace limits, missing TextMate grammars, bundled TS fallback
 * - Benign AI "empty output" stream errors (already handled/retried in-process)
 */
export function sentryBeforeSendDropExpected(
  event: ErrorEvent,
  hint?: EventHint,
): ErrorEvent | null {
  const parts: string[] = [];
  if (event.message) parts.push(normalizeSentryErrorText(event.message));
  const values = event.exception?.values;
  if (values) {
    for (const ex of values) {
      if (ex.value) parts.push(normalizeSentryErrorText(ex.value));
      if (ex.type) parts.push(ex.type);
    }
  }
  const original = hint?.originalException;
  // Intentional stream-stop aborts (ask_user_pending, task_complete, loop guard,
  // compass limit) end turns by design — the main-process safety net already
  // swallows them, but Sentry's own onunhandledrejection integration captures
  // them independently, so drop them here too.
  if (isStreamStopAbort(original)) return null;
  if (isPlanLimitError(original)) return null;
  // Structured match catches the benign empty-output family even when the
  // serialized message text varies (AI SDK wraps/nests these).
  if (isNoUsableModelOutputError(original)) return null;
  if (original instanceof Error) {
    parts.push(original.message, original.name);
  } else if (typeof original === "string") {
    parts.push(original);
  }
  const combined = parts.join("\n");

  // Text fallback for stream-stop aborts whose DOMException Sentry's
  // onunhandledrejection integration didn't attach as originalException
  // (isStreamStopAbort above only sees the structured original). The
  // serialized "AbortError: <sentinel>" still carries the sentinel word.
  if (textHasStreamStopSentinel(combined)) return null;

  if (sentryMessageMatchesIgnoredPattern(combined)) {
    return null;
  }

  return redactEventSecrets(event);
}
