/**
 * `scripts/store-submit.mjs` and the one pending-submission slot a Store product has.
 *
 * History: it used to delete whatever was pending, which cancelled certification on
 * every fast release (the Store sat on 14.51.0 from 2026-09-23 through 15.7.1), so
 * 339ccb91 made it leave a certifying submission alone and skip the release. Then the
 * opposite bit: 15.8.x never reached the Store while 15.7.1 certified. The owner chose
 * the newest release (2026-10-18), so a submission in certification is replaced again —
 * on purpose — and only one Microsoft is mid-commit or mid-publish is waited for.
 */

import { describe, expect, it, vi } from "vitest";

import {
  api,
  awaitCommit,
  clearPending,
  isRetryable,
  pendingSubmissionAction,
  retryDelayMs,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error — a plain .mjs build script with no type declarations.
} from "../../scripts/store-submit.mjs";

describe("pendingSubmissionAction", () => {
  it.each(["PreProcessing", "Certification", "Release"])(
    "REPLACES a submission still being certified (%s): the newest release wins",
    (status) => {
      expect(pendingSubmissionAction(status)).toBe("replace");
    },
  );

  it.each([
    "PendingCommit",
    "CommitFailed",
    "PreProcessingFailed",
    "CertificationFailed",
    "ReleaseFailed",
    "PublishFailed",
    "Canceled",
  ])("replaces one that never started or failed (%s)", (status) => {
    expect(pendingSubmissionAction(status)).toBe("replace");
  });

  it.each(["CommitStarted", "PendingPublication", "Publishing", "SomethingNew", undefined])(
    "waits on one Microsoft is mid-operation on, or a status it doesn't know (%s)",
    (status) => {
      expect(pendingSubmissionAction(status)).toBe("wait");
    },
  );
});

describe("retries", () => {
  it("retries a 429 always, a 5xx except on a POST, and nothing else", () => {
    expect(isRetryable("GET", 429)).toBe(true);
    expect(isRetryable("POST", 429)).toBe(true);
    expect(isRetryable("DELETE", 503)).toBe(true);
    expect(isRetryable("POST", 503)).toBe(false);
    expect(isRetryable("GET", 409)).toBe(false);
  });

  it("waits what Retry-After says, else backs off", () => {
    expect(retryDelayMs(1, "7")).toBe(7000);
    expect(retryDelayMs(1, null)).toBe(2000);
    expect(retryDelayMs(3, null)).toBe(8000);
    expect(retryDelayMs(10, null)).toBe(60_000);
  });

  it("gets through a rate limit, and gives up after five tries", async () => {
    const waits: number[] = [];
    const wait = async (ms: number) => void waits.push(ms);
    let calls = 0;
    const flaky = vi.fn(async () => {
      calls += 1;
      return calls < 3
        ? new Response("slow down", { status: 429, headers: { "retry-after": "1" } })
        : new Response(JSON.stringify({ id: "a" }), { status: 200 });
    });
    expect(await api("t", "GET", "applications/x", undefined, { fetchImpl: flaky, wait })).toEqual({ id: "a" });
    expect(waits).toEqual([1000, 1000]);

    const down = vi.fn(async () => new Response("no", { status: 503 }));
    await expect(api("t", "GET", "applications/x", undefined, { fetchImpl: down, wait })).rejects.toThrow("503");
    expect(down).toHaveBeenCalledTimes(5);
  });
});

/** A fake Store: `script` answers each call in order. */
function store(script: Array<(method: string, path: string) => unknown>) {
  const log: string[] = [];
  let i = 0;
  const call = async (method: string, path: string) => {
    log.push(`${method} ${path}`);
    const step = script[i++];
    if (!step) throw new Error(`unexpected ${method} ${path}`);
    return step(method, path);
  };
  return { call, log };
}
const conflict = () => {
  throw Object.assign(new Error("409"), { status: 409 });
};
const noWait = { wait: async () => {}, waitMs: 60_000, pollMs: 30_000 };

describe("clearPending", () => {
  it("deletes a submission in certification and goes ahead", async () => {
    const s = store([
      () => ({ pendingApplicationSubmission: { id: "s1" } }),
      () => ({ status: "Certification" }),
      () => null,
    ]);
    expect(await clearPending(s.call, "APP", noWait)).toBe(true);
    expect(s.log.at(-1)).toBe("DELETE applications/APP/submissions/s1");
  });

  it("goes ahead at once when nothing is pending", async () => {
    const s = store([() => ({})]);
    expect(await clearPending(s.call, "APP", noWait)).toBe(true);
  });

  it("on a 409 looks again, and goes ahead once Microsoft has published it", async () => {
    const s = store([
      () => ({ pendingApplicationSubmission: { id: "s1" } }),
      () => ({ status: "Release" }),
      conflict,
      () => ({}), // published meanwhile: the slot is free
    ]);
    expect(await clearPending(s.call, "APP", noWait)).toBe(true);
  });

  it("waits on one being published and skips this release if it is still there", async () => {
    const publishing = [
      () => ({ pendingApplicationSubmission: { id: "s1" } }),
      () => ({ status: "Publishing" }),
    ];
    const s = store([...publishing, ...publishing, ...publishing]);
    expect(await clearPending(s.call, "APP", noWait)).toBe(false);
    expect(s.log.some((l) => l.startsWith("DELETE"))).toBe(false);
  });
});

describe("awaitCommit", () => {
  it("waits for CommitStarted to resolve and says how it ended", async () => {
    const s = store([() => ({ status: "CommitStarted" }), () => ({ status: "PreProcessing" })]);
    expect(await awaitCommit(s.call, "APP", "s2", noWait)).toEqual({ status: "PreProcessing" });
    expect(s.log).toEqual(["GET applications/APP/submissions/s2/status", "GET applications/APP/submissions/s2/status"]);
  });
});
