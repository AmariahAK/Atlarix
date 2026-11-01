/**
 * `scripts/store-submit.mjs` and the one pending-submission slot a Store product has.
 *
 * History: it used to delete whatever was pending, which cancelled certification on
 * every fast release (the Store sat on 14.51.0 from 2026-09-23 through 15.7.1), so
 * 339ccb91 made it leave a certifying submission alone and skip the release. Then the
 * opposite bit: 15.8.x never reached the Store while 15.7.1 certified, and 82a24426
 * (2026-10-18) replaced a submission in certification again. That restarted the
 * days-long restricted-capability review on every release, so nothing published at
 * all. A submission Microsoft is processing or certifying is waited for once more.
 */

import { describe, expect, it, vi } from "vitest";

import {
  api,
  awaitCommit,
  certificationNotes,
  clearPending,
  isRetryable,
  pendingSubmissionAction,
  retryDelayMs,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error — a plain .mjs build script with no type declarations.
} from "../../scripts/store-submit.mjs";

describe("pendingSubmissionAction", () => {
  it("reuses a draft (PendingCommit), so what was set on it by hand survives", () => {
    expect(pendingSubmissionAction("PendingCommit")).toBe("reuse");
  });

  // 2026-10-25: the API reports a cancelled certification as "Canceled", yet a
  // PUT on it answers 409 InvalidState "PreProcessing". Only Partner Center can refill it.
  it("leaves a cancelled submission (Canceled) to Partner Center", () => {
    expect(pendingSubmissionAction("Canceled")).toBe("manual");
  });

  it.each([
    "CommitFailed",
    "PreProcessingFailed",
    "CertificationFailed",
    "ReleaseFailed",
    "PublishFailed",
  ])("replaces one that failed (%s)", (status) => {
    expect(pendingSubmissionAction(status)).toBe("replace");
  });

  it.each([
    "PreProcessing",
    "Certification",
    "Release",
    "CommitStarted",
    "PendingPublication",
    "Publishing",
    "SomethingNew",
    undefined,
  ])(
    "waits on one Microsoft is processing or certifying, or a status it doesn't know (%s)",
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
  it("leaves a submission in certification alone and skips this release", async () => {
    const certifying = [
      () => ({ pendingApplicationSubmission: { id: "s1" } }),
      () => ({ status: "Certification" }),
    ];
    const s = store([...certifying, ...certifying, ...certifying]);
    expect(await clearPending(s.call, "APP", noWait)).toBe(false);
    expect(s.log.some((l) => l.startsWith("DELETE"))).toBe(false);
  });

  it("deletes a failed submission and goes ahead", async () => {
    const s = store([
      () => ({ pendingApplicationSubmission: { id: "s1" } }),
      () => ({ status: "CertificationFailed" }),
      () => null,
    ]);
    expect(await clearPending(s.call, "APP", noWait)).toBe(true);
    expect(s.log.at(-1)).toBe("DELETE applications/APP/submissions/s1");
  });

  it("hands back a draft to reuse instead of deleting it", async () => {
    const s = store([
      () => ({ pendingApplicationSubmission: { id: "s1" } }),
      () => ({ status: "PendingCommit" }),
    ]);
    expect(await clearPending(s.call, "APP", noWait)).toBe("s1");
    expect(s.log.some((l) => l.startsWith("DELETE"))).toBe(false);
  });

  it("stops on a cancelled submission: no delete, no reuse, and says to upload in Partner Center", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => void lines.push(String(m)));
    try {
      const s = store([
        () => ({ pendingApplicationSubmission: { id: "s1" } }),
        () => ({ status: "Canceled" }),
      ]);
      expect(await clearPending(s.call, "APP", noWait)).toBe(false);
      expect(s.log.filter((l) => !l.startsWith("GET"))).toEqual([]);
      expect(lines.join("\n")).toMatch(/::error::.*Partner Center/);
      expect(lines.join("\n")).toContain("/submissions/s1");
    } finally {
      spy.mockRestore();
    }
  });

  it("goes ahead at once when nothing is pending", async () => {
    const s = store([() => ({})]);
    expect(await clearPending(s.call, "APP", noWait)).toBe(true);
  });

  it("on a 409 looks again, and goes ahead once Microsoft has published it", async () => {
    const s = store([
      () => ({ pendingApplicationSubmission: { id: "s1" } }),
      () => ({ status: "PublishFailed" }),
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

describe("certification notes", () => {
  it("go with every submission, explain both restricted capabilities, and fit the field", () => {
    const notes = certificationNotes();
    expect(notes).toContain("runFullTrust");
    expect(notes).toContain("unvirtualizedResources");
    expect(notes.length).toBeLessThanOrEqual(2000);
  });
});
