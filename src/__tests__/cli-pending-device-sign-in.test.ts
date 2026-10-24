/**
 * "Sign in with a code" again while a code is still good shows THAT code: each
 * new one is another waiting code on the server, which allows about five per
 * network before ten minutes of "Too many sign-ins waiting" (15.11.1 QA).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetDeviceSignInForTests,
  deviceSignIn,
  pendingDeviceSignIn,
} from "@/cli/auth/pending-device-sign-in";

let clock = 0;
const now = () => clock;
let started = 0;
let finish: (email: string) => void = () => {};
const start = (
  show: (d: {
    userCode: string;
    verificationUri: string;
    expiresInS: number;
  }) => void,
) => {
  started++;
  show({
    userCode: `CODE-${started}`,
    verificationUri: "https://atlarix.dev/auth/cli",
    expiresInS: 600,
  });
  return new Promise<string>((r) => (finish = r));
};
const accept = async () => "me@example.com";

beforeEach(() => {
  __resetDeviceSignInForTests();
  clock = 0;
  started = 0;
});

describe("sign in with a code, asked again", () => {
  it("shows the same code while it is still good, with the time left", async () => {
    const a = deviceSignIn(accept, now, start);
    expect((await a.code).userCode).toBe("CODE-1");
    clock = 120_000;
    const b = deviceSignIn(accept, now, start);
    expect(await b.code).toEqual({
      userCode: "CODE-1",
      verificationUri: "https://atlarix.dev/auth/cli",
      expiresInS: 480,
    });
    expect(started).toBe(1);
  });

  it("starts a new one when the code is about to expire", async () => {
    await deviceSignIn(accept, now, start).code;
    clock = 590_000;
    expect((await deviceSignIn(accept, now, start).code).userCode).toBe(
      "CODE-2",
    );
  });

  it("waiting on it never starts one", async () => {
    expect(pendingDeviceSignIn()).toBeNull();
    const a = deviceSignIn(accept, now, start);
    expect(pendingDeviceSignIn()).toBe(a.done);
    expect(started).toBe(1);
  });

  it("starts a new one once the last sign-in ended", async () => {
    const a = deviceSignIn(accept, now, start);
    await a.code;
    finish("me@example.com");
    await a.done;
    expect((await deviceSignIn(accept, now, start).code).userCode).toBe(
      "CODE-2",
    );
  });

  it("a failure before any code is told through the code", async () => {
    const failing = () =>
      Promise.reject(
        new Error(
          "Too many sign-ins waiting from this network. Try again in ten minutes.",
        ),
      );
    await expect(deviceSignIn(accept, now, failing).code).rejects.toThrow(
      /Too many sign-ins/,
    );
    // …and the next ask starts afresh.
    expect((await deviceSignIn(accept, now, start).code).userCode).toBe(
      "CODE-1",
    );
  });
});
