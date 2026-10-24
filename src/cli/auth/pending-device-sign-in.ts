/**
 * One "sign in with a code" per process, reused while its code is still good.
 *
 * Going back from the code (the panel's Back, the CLI's esc) used to leave that
 * code waiting on the server, and asking again made another. The server allows
 * about five waiting codes per network, then answers "Too many sign-ins waiting
 * from this network. Try again in ten minutes." (ai-ec, 15.11.1 QA): a few
 * code/Back rounds locked a person out. There is no cancel a signed-out client
 * can call, so asking again shows the SAME code while it lasts.
 */
import { signInWithDeviceCode } from "./device-sign-in";
import type { Tokens } from "./browser-sign-in";

export type DeviceCode = {
  userCode: string;
  verificationUri: string;
  expiresInS: number;
};

/** Codes this close to expiring are not handed out again: there'd be no time to type them. */
const REUSE_MARGIN_MS = 30_000;

type Start = (show: (d: DeviceCode) => void) => Promise<string>;

let pending: {
  done: Promise<string>;
  code: Promise<DeviceCode>;
  expiresAt: number | null;
} | null = null;

/**
 * The code to show and the sign-in it belongs to: the one under way if its code
 * is still good, else a new one. `done` resolves with the account's email.
 */
export function deviceSignIn(
  acceptSession: (t: Tokens) => Promise<string>,
  now: () => number = Date.now,
  start: Start = (show) => signInWithDeviceCode({ acceptSession, show }),
): { code: Promise<DeviceCode>; done: Promise<string> } {
  if (
    pending &&
    (pending.expiresAt === null || now() < pending.expiresAt - REUSE_MARGIN_MS)
  ) {
    const p = pending;
    return {
      code: p.code.then((c) => ({
        ...c,
        expiresInS: Math.max(
          0,
          Math.round(((p.expiresAt ?? now()) - now()) / 1000),
        ),
      })),
      done: p.done,
    };
  }
  let shown: (d: DeviceCode) => void = () => {};
  let failed: (e: unknown) => void = () => {};
  const code = new Promise<DeviceCode>((resolve, reject) => {
    shown = resolve;
    failed = reject;
  });
  const entry: NonNullable<typeof pending> = {
    done: Promise.resolve(""),
    code,
    expiresAt: null,
  };
  entry.done = start((d) => {
    entry.expiresAt = now() + d.expiresInS * 1000;
    shown(d);
  });
  // Failing before there is a code (offline, too many waiting): the code says why.
  entry.done.catch(failed);
  // Ended either way: the next ask starts afresh.
  const clear = () => {
    if (pending === entry) pending = null;
  };
  entry.done.then(clear, clear);
  pending = entry;
  return { code, done: entry.done };
}

/** The sign-in under way, if any (waiting on it must never start one). */
export function pendingDeviceSignIn(): Promise<string> | null {
  return pending?.done ?? null;
}

export function __resetDeviceSignInForTests(): void {
  pending = null;
}
