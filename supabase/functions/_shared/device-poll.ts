/**
 * What `cli-device` answers a poll with, from `cli_device_poll_service`'s result
 * (RFC 8628 §3.5). Kept free of Deno imports so the CLI's tests can run it.
 *
 * A database failure answers `slow_down`, never `expired_token`: the CLI backs
 * off and asks again, where an error would end a sign-in that is still valid.
 */
export type PollResult = { ok?: boolean; state?: string; error?: string; sealed_session?: unknown } | null;

const ERRORS: Record<string, string> = {
  pending: "authorization_pending",
  slow_down: "slow_down",
  denied: "access_denied",
  expired: "expired_token",
};

export function pollAnswer(data: PollResult, error: unknown): { status: number; body: Record<string, string> } {
  if (!error && data?.ok === true) {
    if (data.state === "approved" && typeof data.sealed_session === "string") {
      return { status: 200, body: { sealed_session: data.sealed_session } };
    }
    const mapped = data.state ? ERRORS[data.state] : undefined;
    if (mapped) return { status: 400, body: { error: mapped } };
  }
  return { status: 400, body: { error: "slow_down" } };
}
