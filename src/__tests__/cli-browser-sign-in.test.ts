/**
 * The CLI's browser sign-in listener, driven the way the browser drives it:
 * the page is fetched, then the fragment is POSTed to /token.
 */
import http from "node:http";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { signInWithBrowser, type Tokens } from "@/cli/auth/browser-sign-in";

function start(
  accept: (t: Tokens) => Promise<string> = async () => "me@example.com",
  provider?: "github" | "google" | "discord" | "email",
) {
  let url = "";
  const accepted: Tokens[] = [];
  const done = signInWithBrowser({
    openUrl: (u) => void (url = u),
    acceptSession: async (t) => {
      accepted.push(t);
      return accept(t);
    },
    timeoutMs: 5_000,
    ...(provider ? { provider } : {}),
  });
  const ready = async () => {
    for (let i = 0; i < 100 && !url; i++) await new Promise((r) => setTimeout(r, 10));
    const page = new URL(url);
    return {
      port: page.searchParams.get("port")!,
      state: page.searchParams.get("state")!,
      page,
    };
  };
  return { done, ready, accepted };
}

const post = (port: string, body: string) =>
  fetch(`http://127.0.0.1:${port}/token`, { method: "POST", body });

/** fetch() drops a Host header silently; a rebinding attacker's browser sends its own. */
const postWithHost = (port: string, body: string, host: string) =>
  new Promise<number>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: Number(port), path: "/token", method: "POST", headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });

describe("browser sign-in", () => {
  it("opens atlarix.dev for the CLI, on a loopback port, with a nonce", async () => {
    const s = start();
    const { page, port, state } = await s.ready();
    expect(page.origin + page.pathname).toBe("https://atlarix.dev/auth/app");
    expect(page.searchParams.get("client")).toBe("cli");
    expect(Number(port)).toBeGreaterThan(1023);
    expect(state).toMatch(/^[A-Za-z0-9_-]{32}$/);
    await post(port, `access_token=a&refresh_token=r&state=${state}`);
    await s.done;
  });

  it("names the way in already chosen, so the page starts it; none: the page asks", async () => {
    const chosen = start(undefined, "discord");
    const a = await chosen.ready();
    expect(a.page.searchParams.get("provider")).toBe("discord");
    await post(a.port, `access_token=a&refresh_token=r&state=${a.state}`);
    await chosen.done;
    const unchosen = start();
    const b = await unchosen.ready();
    expect(b.page.searchParams.has("provider")).toBe(false);
    await post(b.port, `access_token=a&refresh_token=r&state=${b.state}`);
    await unchosen.done;
  });

  it("serves a callback page that forwards the fragment", async () => {
    const s = start();
    const { port, state } = await s.ready();
    const html = await (await fetch(`http://127.0.0.1:${port}/callback`)).text();
    expect(html).toContain('fetch("/token"');
    await post(port, `access_token=a&refresh_token=r&state=${state}`);
    await s.done;
  });

  it("accepts the session with the right state, then stops listening", async () => {
    const s = start();
    const { port, state } = await s.ready();
    const res = await post(port, `access_token=at&refresh_token=rt&state=${state}`);
    expect(await res.text()).toContain("Signed in as me@example.com");
    expect(await s.done).toBe("me@example.com");
    expect(s.accepted).toEqual([{ access_token: "at", refresh_token: "rt" }]);
    await expect(fetch(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
  });

  it("refuses a different state and keeps waiting for the real one", async () => {
    const s = start();
    const { port, state } = await s.ready();
    const bad = await post(port, `access_token=evil&refresh_token=evil&state=${"x".repeat(32)}`);
    expect(bad.status).toBe(400);
    expect(s.accepted).toEqual([]);
    await post(port, `access_token=at&refresh_token=rt&state=${state}`);
    expect(await s.done).toBe("me@example.com");
  });

  it("refuses a request whose Host is not the loopback address (DNS rebinding)", async () => {
    const s = start();
    const { port, state } = await s.ready();
    expect(await postWithHost(port, `access_token=a&refresh_token=r&state=${state}`, "evil.example:80")).toBe(403);
    expect(s.accepted).toEqual([]);
    await post(port, `access_token=a&refresh_token=r&state=${state}`);
    await s.done;
  });

  it("reports a refusal from the account check (e.g. no email)", async () => {
    const s = start(async () => {
      throw new Error("This account has no email address.");
    });
    const outcome = s.done.catch((e: Error) => e);
    const { port, state } = await s.ready();
    const res = await post(port, `access_token=a&refresh_token=r&state=${state}`);
    expect(res.status).toBe(400);
    expect(String(await outcome)).toContain("no email");
  });

  // ATLARIX-46: a request still arriving when the sign-in finished (the page's
  // second fetch, a favicon) reached a closed server and read a null address.
  it("answers 503 to a request that arrives after the sign-in finished, and never throws", async () => {
    const s = start();
    const { port, state } = await s.ready();
    const thrown: unknown[] = [];
    const onUncaught = (e: unknown) => thrown.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      // Headers started before the sign-in finishes, completed after it.
      const sock = net.connect(Number(port), "127.0.0.1");
      await new Promise((r) => sock.once("connect", r));
      sock.write(`GET /callback HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
      await new Promise((r) => setTimeout(r, 50));
      await post(port, `access_token=a&refresh_token=r&state=${state}`);
      expect(await s.done).toBe("me@example.com");
      let raw = "";
      sock.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      const closed = new Promise((r) => sock.once("close", r));
      sock.write("\r\n");
      await Promise.race([closed, new Promise((r) => setTimeout(r, 2_000))]);
      sock.destroy();
      expect(raw).toMatch(/^HTTP\/1\.1 503/);
      expect(thrown).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
