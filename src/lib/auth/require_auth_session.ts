import type { Session } from "@supabase/supabase-js";
import {
  ATLARIX_AUTH_REQUIRED_PREFIX,
  AUTH_REQUIRED_USER_MESSAGE,
} from "@/shared/auth_ipc";
import { getSession } from "./supabase-client";

export { ATLARIX_AUTH_REQUIRED_PREFIX, AUTH_REQUIRED_USER_MESSAGE };

export class AuthRequiredError extends Error {
  readonly code = "auth_required" as const;
  constructor(message: string = AUTH_REQUIRED_USER_MESSAGE) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

/** Throws AuthRequiredError if there is no Supabase session with a user. */
export async function requireAuthSession(): Promise<Session> {
  const session = await getSession();
  if (!session?.user?.id) {
    throw new AuthRequiredError();
  }
  return session;
}

export function formatAuthRequiredIpcError(): string {
  return `${ATLARIX_AUTH_REQUIRED_PREFIX}${AUTH_REQUIRED_USER_MESSAGE}`;
}
