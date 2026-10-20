/**
 * Patterns for expected errors that should not open Sentry issues or email alerts.
 * Used by `ignoreErrors` and `sentryBeforeSendDropExpected`.
 *
 * THE PLAN-GATE PATTERNS ARE GONE (2026-09-09). The app went free on 2026-09-08, so
 * `PlanLimitError`, `Free plan allows N workspace` and `Upgrade to Pro for unlimited
 * workspaces` describe errors nothing can produce any more — there is no workspace cap
 * at all (`workspace-quota.ts`) and the last free-tier MCP gate was removed with this
 * change. They survived only because a test fixture constructed the error by hand.
 *
 * What replaced them is `WORKSPACE_CAP_SENTRY_PATTERNS`, which lives beside the message
 * it matches. The old `/Workspace limit reached/i` entry sat here, three files from the
 * refusal, and matched the wording the RENDERER rebuilt rather than the wording the
 * handler threw — so for the skills cap the drop never fired at all.
 */
import { WORKSPACE_CAP_SENTRY_PATTERNS } from "@/lib/workspace-caps";

export const SENTRY_IGNORE_ERROR_PATTERNS: RegExp[] = [
  /ATLARIX_AUTH_REQUIRED/i,
  /Please sign in or sign up to use Atlarix/i,
  /AuthRequiredError/i,
  // Hitting a per-workspace resource cap is expected behaviour, not a defect.
  ...WORKSPACE_CAP_SENTRY_PATTERNS,
  /Missing grammar for scope:/i,
  // Benign Electron teardown races: an async callback/broadcast touches a
  // window/webContents that's already destroyed during quit. Guarded at the
  // source (broadcastToAllWindows + safeSend); dropped here as a safety net.
  /Object has been destroyed/i,
  /Render frame was disposed/i,
  /invalid pattern in look-behind/i,
  /look-behind/i,
  /OnigScanner/i,
  /OnigScanner\.findNextMatchSync/i,
  /Failed to load TypeScript from[\s\S]*Cannot find module 'typescript'/i,
  // v12.7: benign AI stream "empty output" — already handled in-process (retried
  // and surfaced to the user, or a no-op flush). Noise, not actionable.
  /No output generated/i,
  /AI_NoOutputGeneratedError/i,
  /AI_NoContentGeneratedError/i,
  /NoOutputGeneratedError/i,
  /NoContentGeneratedError/i,
  /EmptyModelOutputAfterRetry/i,
  // Expected outcomes the user is told about, not defects (Sentry, Oct 2026):
  // a duplicate app name, and the catalog refresh timing out (it falls back to
  // the cached catalog). The MCP cap is in WORKSPACE_CAP_SENTRY_PATTERNS.
  /An app with this name already exists/i,
  /models\.dev refresh exceeded/i,
];

export function sentryMessageMatchesIgnoredPattern(combined: string): boolean {
  return SENTRY_IGNORE_ERROR_PATTERNS.some((re) => re.test(combined));
}
