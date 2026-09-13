/**
 * Is there an account, and can it actually do anything?
 *
 * THIS EXISTS BECAUSE THE TWO QUESTIONS ARE DIFFERENT AND THE PANEL CONFLATED
 * THEM. `getSession()` answers "is there a record in storage" — which is true
 * for a session whose access token expired hours ago and whose refresh token
 * has since been spent. The side panel used that as its signed-in test, hid the
 * provider buttons, and rendered a chat in which every Core call came back 401.
 * The user was left with an interface offering no way in and no way out, and
 * the only message on screen blamed their network.
 *
 * `getAccessToken()` answers the question that matters: it refreshes if it can,
 * and CLEARS the stored session if the refresh is refused. So the honest test
 * for "signed in" is "a token came back", and it must be the same call Core
 * itself will make — otherwise the UI and the server hold different opinions
 * about the same account and only one of them is right.
 *
 * The profile is read FIRST, deliberately: a refused refresh wipes the record,
 * and the caller still wants the email it is about to stop showing.
 */

import { getAccessToken, getSession } from "./sign-in";
import type { StoredSession } from "./session";

export interface AccountState {
  /** A usable token exists. The only thing the UI should branch on. */
  signedIn: boolean;
  /**
   * The stored profile, even when `signedIn` is false — so a panel can say
   * whose session just expired instead of going blank.
   */
  session: StoredSession | null;
}

export async function accountState(): Promise<AccountState> {
  const session = await getSession();
  if (!session) return { signedIn: false, session: null };
  const token = await getAccessToken();
  return { signedIn: Boolean(token), session };
}
