/**
 * The panel's half of the sandbox protocol.
 *
 * ONE PROPERTY MATTERS MORE THAN THE REST: **a run is offered exactly once.**
 *
 * `relics/relic.ts` re-offers its payload every 100 ms until the sandbox
 * acknowledges, and it has to — its listener was attached after the frame had
 * already spoken, and a missed event is missed forever. Copying that shape here
 * would run the model's code twice: two files, arithmetic done twice, and a
 * failure that depends on timing, so it would be green on this machine and
 * wrong on a loaded one. The test asserts the message count directly, because
 * the duplicate is invisible in any result.
 *
 * The rest is about what happens when the frame stops answering. An iframe that
 * has crashed is still an element, still has a `contentWindow`, and still takes
 * a `postMessage` without complaint — so "no answer" is the only evidence there
 * is, and it has to end in a fresh frame rather than a hung turn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/browser-api", () => ({
  api: () => ({
    runtime: { getURL: (p: string) => `chrome-extension://test/${p}` },
  }),
}));

import { resetSandbox, runInSandbox } from "./run";

/** Everything the panel posted INTO the frame. */
let posted: Array<Record<string, unknown>>;
let contentWindow: PropertyDescriptor | undefined;

beforeEach(() => {
  posted = [];
  document.body.innerHTML = "";
  resetSandbox();

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ text: async () => "/* prelude */" })),
  );

  // jsdom will not load a chrome-extension: URL, so the frame's window is
  // stubbed. What is under test is the conversation, not the frame.
  contentWindow = Object.getOwnPropertyDescriptor(
    HTMLIFrameElement.prototype,
    "contentWindow",
  );
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    configurable: true,
    get: () => ({
      postMessage: (message: Record<string, unknown>) => posted.push(message),
    }),
  });
});

afterEach(() => {
  if (contentWindow) {
    Object.defineProperty(
      HTMLIFrameElement.prototype,
      "contentWindow",
      contentWindow,
    );
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetSandbox();
});

function say(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

/** Let the mount promise and the prelude fetch settle. */
async function settle(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

async function ready(): Promise<void> {
  await settle();
  say({ kind: "atlarix:runner-ready" });
  await settle();
}

describe("asking the sandbox to run something", () => {
  it("offers the run ONCE and never repeats it", async () => {
    const pending = runInSandbox({ code: "1" });
    await ready();

    expect(posted).toHaveLength(1);
    expect(posted[0]!.kind).toBe("atlarix:run");
    expect(posted[0]!.code).toBe("1");

    // The window a retry loop would use. If one is ever added, this is where it
    // shows up — and the second run is the one nobody would notice.
    await settle(40);
    expect(posted).toHaveLength(1);

    say({ kind: "atlarix:run-result", id: posted[0]!.id, ok: true, files: [] });
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it("carries the worker's own source, read from our package", async () => {
    const pending = runInSandbox({ code: "1" });
    await ready();
    expect(posted[0]!.prelude).toBe("/* prelude */");
    say({ kind: "atlarix:run-result", id: posted[0]!.id, ok: true, files: [] });
    await pending;
  });

  it("ignores an answer addressed to a different run", async () => {
    const pending = runInSandbox({ code: "1" });
    await ready();

    say({ kind: "atlarix:run-result", id: "someone-else", ok: true, stdout: "wrong" });
    await settle();

    say({
      kind: "atlarix:run-result",
      id: posted[0]!.id,
      ok: true,
      stdout: "mine",
      files: [],
    });
    await expect(pending).resolves.toMatchObject({ stdout: "mine" });
  });

  it("reuses the frame for a second run rather than mounting another", async () => {
    const first = runInSandbox({ code: "1" });
    await ready();
    say({ kind: "atlarix:run-result", id: posted[0]!.id, ok: true, files: [] });
    await first;

    const second = runInSandbox({ code: "2" });
    await settle();
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(posted).toHaveLength(2);

    say({ kind: "atlarix:run-result", id: posted[1]!.id, ok: true, files: [] });
    await second;
  });

  it("normalises a malformed answer instead of passing it through", async () => {
    // The frame is not a trusted peer — it runs code written by a model. A
    // result missing `files` must not become `undefined` in the panel, where
    // the card loop would throw and take the turn's rendering with it.
    const pending = runInSandbox({ code: "1" });
    await ready();
    say({ kind: "atlarix:run-result", id: posted[0]!.id, ok: "yes", files: "nope" });
    await expect(pending).resolves.toEqual({
      ok: true,
      stdout: "",
      truncated: false,
      error: null,
      value: null,
      files: [],
    });
  });
});

describe("when the frame stops answering", () => {
  it("tears it down and says so, rather than hanging the turn", async () => {
    vi.useFakeTimers();
    const pending = runInSandbox({ code: "1", timeoutMs: 1_000 });

    // Mount is a promise chain, so it needs microtask turns, not clock time.
    await settle();
    say({ kind: "atlarix:runner-ready" });
    await settle();
    expect(posted).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/stopped responding and was restarted/);
    // The dead frame is GONE. Reusing it would inherit whatever state broke it.
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("gives up on a frame that never loads, with a sentence a user can act on", async () => {
    vi.useFakeTimers();
    // The handler is attached NOW rather than after the clock is advanced.
    // `expect().rejects` would attach a microtask too late, and the rejection
    // is reported as unhandled in between — which is noise that looks exactly
    // like a real defect the next time someone reads this output.
    const pending = runInSandbox({ code: "1" }).catch((err: unknown) => err);
    await settle();
    // No ready message, ever.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(String(await pending)).toMatch(/did not load/);
  });
});
