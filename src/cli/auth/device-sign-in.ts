/**
 * `atlarix login --device`: sign in on a machine with no browser (SSH, a server,
 * a container). The CLI shows a short code; the user opens atlarix.dev/auth/cli
 * on any device, signs in, types the code and approves. Meanwhile the CLI polls.
 *
 * The session comes back sealed to a key pair made here for this one sign-in
 * (supabase/functions/_shared/device-seal.ts — the same file the server runs),
 * so neither the server's table nor anything in between holds it readable.
 * The server side and its threat model: supabase/functions/cli-device.
 */
import os from "node:os";
import { makeDeviceKeyPair, openSealed } from "../../../supabase/functions/_shared/device-seal.ts";
import type { Tokens } from "./browser-sign-in";

export interface DeviceCall {
  (body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
}

export interface DeviceSignInOptions {
  call?: DeviceCall;
  /** Told the code and where to enter it, as soon as there is one. */
  show: (info: { userCode: string; verificationUri: string; expiresInS: number }) => void;
  acceptSession: (t: Tokens) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  label?: string;
}

/** The device endpoint, from the same public Supabase config the desktop uses. */
export function defaultDeviceCall(): DeviceCall {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  if (!url) throw new Error("This build has no Atlarix account service configured.");
  return async (body) => {
    const res = await fetch(`${url.replace(/\/$/, "")}/functions/v1/cli-device`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { apikey: key } : {}) },
      body: JSON.stringify(body),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* an empty or non-JSON reply reads as an error below */
    }
    return { status: res.status, body: json };
  };
}

/** What the approve page shows as a hint (the CLI chooses it, so it proves nothing). */
export function deviceLabel(): string {
  const osName = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
  return `${osName} · ${os.hostname()}`.slice(0, 80);
}

export async function signInWithDeviceCode(opts: DeviceSignInOptions): Promise<string> {
  const call = opts.call ?? defaultDeviceCall();
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pair = await makeDeviceKeyPair();

  const started = await call({ action: "start", public_key: pair.publicKey, label: opts.label ?? deviceLabel() });
  if (started.status === 429) throw new Error("Too many sign-ins waiting from this network. Try again in ten minutes.");
  const b = started.body;
  if (started.status !== 200 || typeof b.device_code !== "string" || typeof b.user_code !== "string") {
    throw new Error("Could not start a sign-in. Check the connection and try again.");
  }
  const expiresInS = Number(b.expires_in) || 600;
  let intervalMs = Math.max(1, Number(b.interval) || 5) * 1000;
  opts.show({ userCode: b.user_code, verificationUri: String(b.verification_uri), expiresInS });

  const deadline = Date.now() + expiresInS * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let polled: Awaited<ReturnType<DeviceCall>>;
    try {
      polled = await call({ action: "poll", device_code: b.device_code });
    } catch {
      // A dropped connection on one poll is not the end of the sign-in.
      intervalMs += 5000;
      continue;
    }
    const sealed = polled.body.sealed_session;
    if (polled.status === 200 && typeof sealed === "string") {
      const tokens = JSON.parse(await openSealed(pair, sealed)) as Partial<Tokens>;
      if (!tokens.access_token || !tokens.refresh_token) throw new Error("The sign-in came back without a session.");
      return opts.acceptSession({ access_token: tokens.access_token, refresh_token: tokens.refresh_token });
    }
    switch (polled.body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        intervalMs += 5000;
        continue;
      case "access_denied":
        throw new Error("The sign-in was declined in the browser.");
      case "expired_token":
        throw new Error("The code expired. Run `atlarix login --device` for a new one.");
      default:
        throw new Error("The sign-in stopped unexpectedly. Run `atlarix login --device` to try again.");
    }
  }
  throw new Error("The code expired. Run `atlarix login --device` for a new one.");
}

/**
 * No browser to open here: an SSH session, or Linux with no display. Browser
 * sign-in would open nothing (or open it on the wrong machine), so the device
 * code is the default — as `gh auth login` and others do.
 */
export function shouldUseDeviceCode(env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY) return true;
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}
