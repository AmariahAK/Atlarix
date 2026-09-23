/**
 * The one upgrade line, VERBATIM from the desktop's `src/shared/billing_copy.ts`
 * (UPGRADE_LINE). Copied rather than imported because the extension is built
 * on its own; `upgrade-line.test.ts` fails the moment the two differ.
 */
export const UPGRADE_LINE =
  "Get more with Atlarix Pro — $19/month, includes Core usage across the app, the Chrome extension and Reviewer. Or add credit and pay only for what you use.";

/** Where the two buttons go. Constants — never read from a message. */
export const PRICING_URL = "https://atlarix.dev/pricing";
export const ACCOUNT_URL = "https://atlarix.dev/account";
