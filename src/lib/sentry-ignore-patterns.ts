/**
 * Patterns for expected errors that should not open Sentry issues or email alerts.
 * Used by `ignoreErrors` and `sentryBeforeSendDropExpected`.
 */
export const SENTRY_IGNORE_ERROR_PATTERNS: RegExp[] = [
  /ATLARIX_AUTH_REQUIRED/i,
  /Please sign in or sign up to use Atlarix/i,
  /AuthRequiredError/i,
  /PlanLimitError/i,
  /ATLARIX_PLAN_LIMIT/i,
  /Free plan allows \d+ workspace/i,
  /Workspace limit reached/i,
  /Upgrade to Pro for unlimited workspaces/i,
  /Free tier is limited to 1 MCP/i,
  /Missing grammar for scope:/i,
  /invalid pattern in look-behind/i,
  /look-behind/i,
  /OnigScanner/i,
  /OnigScanner\.findNextMatchSync/i,
  /Failed to load TypeScript from[\s\S]*Cannot find module 'typescript'/i,
];

export function sentryMessageMatchesIgnoredPattern(combined: string): boolean {
  return SENTRY_IGNORE_ERROR_PATTERNS.some((re) => re.test(combined));
}
