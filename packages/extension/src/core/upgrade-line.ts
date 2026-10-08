/**
 * The one upgrade line, VERBATIM from the desktop's `src/shared/billing_copy.ts`
 * (CREDIT_FIRST_LINE). Copied rather than imported because the extension is
 * built on its own; `upgrade-line.test.ts` fails the moment the two differ.
 *
 * Credit leads: the side-panel agent needs a balance, and $10 of credit is
 * what unblocks someone today. It used to lead with the $19 plan, which read
 * as "subscribe to use".
 */
export const CREDIT_FIRST_LINE =
  "Add credit from $10 and pay only for what you use, or get Atlarix Pro ($19/month), which includes Core usage across the app, the Chrome extension and Reviewer.";

/** Where the two buttons go. Constants — never read from a message. */
export const PRICING_URL = "https://atlarix.dev/pricing";
export const ACCOUNT_URL = "https://atlarix.dev/account";
