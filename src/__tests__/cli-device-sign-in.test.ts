import { describe, expect, it } from "vitest";
import { normalizeUserCode, randomUserCode } from "../../supabase/functions/_shared/device-codes.ts";
import { isValidPublicKey, makeDeviceKeyPair, openSealed, sealFor } from "../../supabase/functions/_shared/device-seal.ts";
import { shouldUseDeviceCode, signInWithDeviceCode, type DeviceCall } from "@/cli/auth/device-sign-in";

describe("device-code sealing", () => {
  it("only the key pair it was sealed to can open it", async () => {
    const mine = await makeDeviceKeyPair();
    const other = await makeDeviceKeyPair();
    const sealed = await sealFor(mine.publicKey, '{"access_token":"a","refresh_token":"r"}');
    expect(sealed).not.toContain("refresh_token");
    expect(await openSealed(mine, sealed)).toBe('{"access_token":"a","refresh_token":"r"}');
    await expect(openSealed(other, sealed)).rejects.toThrow();
  });

  it("a tampered seal does not open", async () => {
    const mine = await makeDeviceKeyPair();
    const parts = (await sealFor(mine.publicKey, "secret")).split(".");
    const ct = parts[3]!;
    parts[3] = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    await expect(openSealed(mine, parts.join("."))).rejects.toThrow();
  });

  it("refuses a public key that is not a P-256 point", async () => {
    expect(await isValidPublicKey((await makeDeviceKeyPair()).publicKey)).toBe(true);
    expect(await isValidPublicKey("AAAA")).toBe(false);
    expect(await isValidPublicKey("")).toBe(false);
  });
});

describe("user codes", () => {
  it("XXXX-XXXX, no vowels, and typing is forgiving", () => {
    for (let i = 0; i < 200; i++) expect(randomUserCode()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(normalizeUserCode(" bcdf ghjk ")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("bcdf-ghj")).toBeNull();
    expect(normalizeUserCode("ABCD-EFGH")).toBeNull(); // vowels never issued
  });
});

/** The edge function's poll semantics, in memory. */
function fakeServer(script: Array<"pending" | "slow_down" | "approve" | "deny" | "expire">) {
  let publicKey = "";
  const polls: number[] = [];
  const call: DeviceCall = async (body) => {
    if (body.action === "start") {
      publicKey = String(body.public_key);
      return { status: 200, body: { device_code: "dc", user_code: "BCDF-GHJK", verification_uri: "https://www.atlarix.dev/auth/cli", expires_in: 600, interval: 5 } };
    }
    polls.push(Date.now());
    const step = script.shift() ?? "pending";
    if (step === "approve") {
      return { status: 200, body: { sealed_session: await sealFor(publicKey, JSON.stringify({ access_token: "at", refresh_token: "rt" })) } };
    }
    const error = { pending: "authorization_pending", slow_down: "slow_down", deny: "access_denied", expire: "expired_token" }[step];
    return { status: 400, body: { error } };
  };
  return { call, polls };
}

describe("signInWithDeviceCode", () => {
  it("shows the code, polls until approved, opens the session and keeps it", async () => {
    const { call } = fakeServer(["pending", "slow_down", "approve"]);
    const waits: number[] = [];
    let shown = "";
    let kept: unknown;
    const email = await signInWithDeviceCode({
      call,
      sleep: async (ms) => void waits.push(ms),
      show: (i) => void (shown = i.userCode),
      acceptSession: async (t) => {
        kept = t;
        return "me@example.com";
      },
    });
    expect(email).toBe("me@example.com");
    expect(shown).toBe("BCDF-GHJK");
    expect(kept).toEqual({ access_token: "at", refresh_token: "rt" });
    // slow_down adds five seconds to the interval (RFC 8628 §3.5).
    expect(waits).toEqual([5000, 5000, 10000]);
  });

  it("declined and expired codes end with a clear message", async () => {
    const opts = { sleep: async () => {}, show: () => {}, acceptSession: async () => "x" };
    await expect(signInWithDeviceCode({ ...opts, call: fakeServer(["deny"]).call })).rejects.toThrow(/declined/);
    await expect(signInWithDeviceCode({ ...opts, call: fakeServer(["expire"]).call })).rejects.toThrow(/expired/);
  });

  it("is the default over SSH and on Linux with no display", () => {
    expect(shouldUseDeviceCode({ SSH_CONNECTION: "1 2 3 4" }, "darwin")).toBe(true);
    expect(shouldUseDeviceCode({}, "linux")).toBe(true);
    expect(shouldUseDeviceCode({ DISPLAY: ":0" }, "linux")).toBe(false);
    expect(shouldUseDeviceCode({}, "darwin")).toBe(false);
  });
});
