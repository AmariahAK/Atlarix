/**
 * The buttons under a failed turn, from its text. Pure, so it is tested without
 * a browser (src/__tests__/vscode-error-actions.test.ts); main.ts draws them.
 */
import {
  CORE_EXHAUSTED_MARKER,
  CORE_NEVER_FUNDED_MARKER,
  FREE_BUSY_MARKER,
  FREE_LIMIT_MARKER,
  PRO_ALLOWANCE_MARKER,
} from "../../../src/shared/billing_copy";
import { BYOK_CREDIT_MARKER } from "../../../src/shared/texts";

export type ErrorAction = "credit" | "pro" | "ownKey" | "auto" | "keys";

export function errorActions(text: string): ErrorAction[] {
  // Your own provider's account, not Atlarix's: its billing page is the
  // provider's, so the way on is another model or another key. Checked first:
  // the text says "out of credit" too.
  if (text.includes(BYOK_CREDIT_MARKER)) return ["auto", "keys"];
  if (text.includes(PRO_ALLOWANCE_MARKER)) return ["credit", "ownKey"]; // never "Get Pro" to a Pro account
  if (text.includes(CORE_NEVER_FUNDED_MARKER)) return ["credit", "pro", "auto"];
  if (
    [FREE_LIMIT_MARKER, FREE_BUSY_MARKER, CORE_EXHAUSTED_MARKER].some((m) => text.includes(m)) ||
    /insufficient.credit|out of credit/i.test(text)
  ) {
    return ["credit", "pro", "ownKey"];
  }
  if (/api key|rejected|unauthori[sz]ed|\b401\b/i.test(text)) return ["keys"];
  return [];
}
