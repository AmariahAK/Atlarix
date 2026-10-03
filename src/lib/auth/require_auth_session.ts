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
  // Headless benchmark/automation runs (the Electron-free agent CLI) have no
  // interactive Supabase login. They use BYOK/custom providers (no Core
  // metering), so a synthetic local session satisfies the gate without network.
  // Also the CLI's local-endpoint test mode (`atlarix --provider-url …`), which
  // runs against a scratch data folder and a local model: nothing it does
  // reaches Atlarix's servers, so there is no account to require.
  if (
    process.env.ATLARIX_HEADLESS === "1" ||
    process.env.ATLARIX_CLI_DEV_PROVIDER === "1"
  ) {
    return {
      access_token: "atlarix-headless",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "atlarix-headless",
      user: { id: "atlarix-headless", email: "headless@atlarix.dev" },
    } as unknown as Session;
  }
  const session = await getSession();
  if (!session?.user?.id) {
    throw new AuthRequiredError();
  }
  return session;
}

export function formatAuthRequiredIpcError(): string {
  return `${ATLARIX_AUTH_REQUIRED_PREFIX}${AUTH_REQUIRED_USER_MESSAGE}`;
}
