/**
 * 0t: a test/QA run must never reach the production Sentry project.
 *
 * ATLARIX-47: the esc-interrupt scenario (and the QA packaged app, ATLARIX-48/49)
 * sent a crash to the production project because the harness inherited the prod
 * DSN from the environment and the CLI inited Sentry with it. Two gates now make
 * that structural:
 *
 *  - `sentryDsnForBuild` returns a DSN only for an explicit release build, so a
 *    dev/QA binary embeds none;
 *  - `sentryInitAllowed` is false when the harness marks the run, so even a DSN
 *    in the environment reports nothing.
 *
 * The harness marks every run (tests-bun/preload.ts sets
 * `ATLARIX_SENTRY_DISABLED=1`). The integration test below proves the real
 * `installProcessGuards` init path sends nothing in that state: it runs the
 * exact guard the CLI uses, with a loopback DSN in the environment, and asserts
 * a local server sees no envelope. If the gate is removed, the envelope is sent
 * and the test fails.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
// Resolves through the bun-cli-plugin alias to src/headless/sentry-stub.ts —
// the same module `installProcessGuards` dynamic-imports.
import * as Sentry from "@sentry/electron/main";
import { sentryDsnForBuild, sentryInitAllowed } from "../src/lib/sentry-gate";

const PROD_DSN = "https://abc123@o1.ingest.de.sentry.io/4510981520425040";

let server: ReturnType<typeof Bun.serve> | undefined;
let requests = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      requests++;
      return new Response("ok");
    },
  });
});

afterAll(() => {
  server?.stop(true);
  delete process.env.SENTRY_DSN;
});

test("sentryDsnForBuild embeds a DSN only for an explicit release build", () => {
  // A dev/QA build (no ATLARIX_RELEASE) embeds nothing, prod DSN or not.
  expect(sentryDsnForBuild({ SENTRY_DSN: PROD_DSN })).toBe("");
  expect(sentryDsnForBuild({})).toBe("");
  // An explicit release build embeds the DSN (SENTRY_DSN, falling back to
  // ATLARIX_SENTRY_DSN).
  expect(sentryDsnForBuild({ ATLARIX_RELEASE: "1", SENTRY_DSN: PROD_DSN })).toBe(PROD_DSN);
  expect(sentryDsnForBuild({ ATLARIX_RELEASE: "1", ATLARIX_SENTRY_DSN: PROD_DSN })).toBe(PROD_DSN);
});

test("sentryInitAllowed is false exactly when the harness disables it", () => {
  expect(sentryInitAllowed({})).toBe(true);
  expect(sentryInitAllowed({ ATLARIX_SENTRY_DISABLED: "1" })).toBe(false);
});

test("the harness marks this run as sentry-disabled", () => {
  // The whole point of this file: preload.ts sets it and it must stay set.
  expect(process.env.ATLARIX_SENTRY_DISABLED).toBe("1");
});

test("installProcessGuards sends nothing under the harness, even with a DSN present", async () => {
  Sentry.__resetForTests();
  requests = 0;
  const dsn = `http://key@127.0.0.1:${server!.port}/1`;
  process.env.SENTRY_DSN = dsn;
  try {
    const { installProcessGuards } = await import("../src/cli/shutdown");
    installProcessGuards();
    // The init is a .then on Promise.all of dynamic imports; let its microtask
    // queue drain before probing.
    await new Promise((r) => setTimeout(r, 0));
    // The same capture path the survive() handler uses.
    Sentry.captureException(new Error("would-be prod event"));
    await Sentry.flush(500);
    expect(requests).toBe(0);
  } finally {
    delete process.env.SENTRY_DSN;
  }
});

test("control: a live loopback DSN would have been caught", async () => {
  // Proves the detection itself works: init the stub directly (no gate) and the
  // local server must see the envelope. If this control stopped seeing requests,
  // the assertion above would pass vacuously.
  Sentry.__resetForTests();
  requests = 0;
  Sentry.init({ dsn: `http://key@127.0.0.1:${server!.port}/1` });
  Sentry.captureException(new Error("probe"));
  await Sentry.flush(500);
  expect(requests).toBeGreaterThan(0);
});
