/**
 * Crash reports from the terminal and the editors. The headless build used a
 * no-op Sentry, so the CLI, ACP and the VS Code panel's agent reported
 * nothing. The reporter follows the app's rule and scrubs more than it does:
 * no home folder, working folder, email or secret ever leaves the machine.
 */
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Sentry from "@/headless/sentry-stub";
import { sentryBeforeSendDropExpected } from "@/lib/sentry-before-send";

const DSN = "https://abc123@o1.ingest.de.sentry.io/4510981520425040";
const posts: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
const transport = async (url: string, init: RequestInit) => {
  posts.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
  return {};
};
const event = (i = 0) => JSON.parse(posts[i]!.body.split("\n")[2]!);

beforeEach(() => {
  posts.length = 0;
  Sentry.__resetForTests();
  delete process.env.ATLARIX_HOST_TELEMETRY;
  delete process.env.ATLARIX_SENTRY_DSN;
  Sentry.init({ dsn: DSN, release: "15.9.9", beforeSend: sentryBeforeSendDropExpected as never, transport });
});
afterEach(() => {
  delete process.env.ATLARIX_HOST_TELEMETRY;
});

describe("the CLI's crash reporter", () => {
  it("sends a Sentry envelope to the project, with the surface and release", async () => {
    process.env.ATLARIX_REPORT_SURFACE = "acp";
    process.env.ATLARIX_ACP_EDITOR = "zed";
    Sentry.captureException(new TypeError("boom"));
    await Sentry.flush(500);
    delete process.env.ATLARIX_REPORT_SURFACE;
    delete process.env.ATLARIX_ACP_EDITOR;
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://o1.ingest.de.sentry.io/api/4510981520425040/envelope/");
    expect(posts[0]!.headers["x-sentry-auth"]).toContain("sentry_key=abc123");
    const e = event();
    expect(e).toMatchObject({ platform: "node", level: "error", release: "15.9.9", tags: { surface: "acp", editor: "zed" } });
    expect(e.exception.values[0]).toMatchObject({ type: "TypeError", value: "boom" });
    expect(e.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0);
  });

  it("never sends a home path, the working folder, an email or a token", async () => {
    const home = os.homedir();
    const err = new Error(
      `failed reading ${path.join(home, "secret-project", "a.ts")} in ${process.cwd()} for jane.doe@example.com with sk-ant-api03-${"x".repeat(40)}`,
    );
    err.stack = `Error: ${err.message}\n    at run (${path.join(home, "secret-project", "a.ts")}:1:2)`;
    Sentry.captureException(err);
    await Sentry.flush(500);
    const body = posts[0]!.body;
    expect(body).not.toContain(home);
    expect(body).not.toContain(process.cwd());
    expect(body).not.toContain("jane.doe@example.com");
    expect(body).not.toContain("x".repeat(40));
    // JSON-escaped on Windows: `~\\secret-project`.
    expect(body).toMatch(/~(\/|\\\\)secret-project/);
    expect(body).toContain("<email>");
  });

  it("at most 10 per process, each distinct error once", async () => {
    for (let i = 0; i < 3; i++) Sentry.captureException(new Error("same"));
    for (let i = 0; i < 20; i++) Sentry.captureException(new Error(`distinct ${i}`));
    await Sentry.flush(500);
    expect(posts).toHaveLength(Sentry.MAX_EVENTS);
    expect(posts.filter((p) => p.body.includes('"value":"same"'))).toHaveLength(1);
  });

  it("drops what the app drops (expected errors)", async () => {
    Sentry.captureException(new Error("ATLARIX_AUTH_REQUIRED: sign in"));
    Sentry.captureException(new Error("An app with this name already exists"));
    Sentry.captureMessage("models.dev refresh exceeded 30s timeout", "warning");
    await Sentry.flush(500);
    expect(posts).toEqual([]);
  });

  it("sends nothing when the editor's telemetry is off", async () => {
    process.env.ATLARIX_HOST_TELEMETRY = "off";
    Sentry.captureException(new Error("boom"));
    await Sentry.flush(500);
    expect(posts).toEqual([]);
  });

  it("sends nothing without a DSN, or before init", async () => {
    Sentry.__resetForTests();
    Sentry.captureException(new Error("boom"));
    Sentry.init({ dsn: undefined, transport });
    Sentry.captureException(new Error("boom"));
    await Sentry.flush(500);
    expect(posts).toEqual([]);
  });

  it("a stub DSN is honoured only on this machine", async () => {
    process.env.ATLARIX_SENTRY_DSN = "http://k@127.0.0.1:9461/1";
    Sentry.init({ dsn: DSN, transport });
    Sentry.captureException(new Error("local"));
    process.env.ATLARIX_SENTRY_DSN = "http://k@evil.example/1";
    Sentry.init({ dsn: DSN, transport });
    Sentry.captureException(new Error("remote"));
    await Sentry.flush(500);
    expect(posts.map((p) => p.url)).toEqual([
      "http://127.0.0.1:9461/api/1/envelope/",
      "https://o1.ingest.de.sentry.io/api/4510981520425040/envelope/",
    ]);
  });

  it("flush gives up after its time limit", async () => {
    Sentry.init({ dsn: DSN, transport: () => new Promise(() => {}) });
    Sentry.captureException(new Error("hangs"));
    const started = Date.now();
    expect(await Sentry.flush(100)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
