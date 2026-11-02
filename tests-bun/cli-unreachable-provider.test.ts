/**
 * A provider nobody answers at (it's down, or the address is wrong): the turn
 * ends with that reason, not "Something went wrong" and not stuck working (QA).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { startFakeLlm } from "./fixtures/fake-llm";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

let ws: string;

beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "unreach-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "unreach-ws-"));
});

/** A port nothing listens on. */
async function deadPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe("an unreachable provider", () => {
  it("ends the turn with the connection error", async () => {
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const model = await seedDevProvider({ baseUrl: `http://127.0.0.1:${await deadPort()}/v1`, model: "fake-model", apiKey: "dev" });
    const s = new AgentSession({ workspaceDir: ws, model });
    await s.start();
    const phases: string[] = [];
    s.on("change", (st: { phase: string | null }) => void (st.phase && phases.push(st.phase)));
    await s.submit("say hi");
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`turn never finished: ${JSON.stringify(s.state.lastError)}`)), 60_000);
      const check = () => {
        if (!s.state.busy && s.state.lastError) {
          clearTimeout(t);
          resolve();
        }
      };
      s.on("change", check);
      check();
    });
    expect(s.state.lastError).toContain("Couldn't reach ");
    expect(s.state.lastError).not.toContain("Something went wrong");
    // The wait says what it is.
    expect(phases.some((p) => /retrying in \d+s \(1\/3\)/.test(p))).toBe(true);
  }, 70_000);

  it("a stop during the retry wait says Interrupted, and the earlier error stays under its turn", async () => {
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const model = await seedDevProvider({ baseUrl: `http://127.0.0.1:${await deadPort()}/v1`, model: "fake-model", apiKey: "dev" });
    const s = new AgentSession({ workspaceDir: ws, model });
    await s.start();
    const idle = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("turn never finished")), ms);
        const check = () => {
          if (!s.state.busy) {
            clearTimeout(t);
            s.off("change", check);
            resolve();
          }
        };
        s.on("change", check);
      });
    let done = idle(60_000);
    await s.submit("Say hi.");
    await done;
    expect(s.state.lastError).toContain("Couldn't reach");
    done = idle(20_000);
    const unsent: string[] = [];
    s.on("unsent", (t: string) => unsent.push(t));
    await s.submit("Say hello.");
    await new Promise((r) => setTimeout(r, 1000)); // inside the first retry wait
    // The wait says what it is, not "Thinking…" (QA).
    expect(s.state.retrying ?? "").toMatch(/retrying in \d+s \(1\/3\)/);
    // Typed into the turn while it waits: there's no step to deliver it at.
    await s.submit("And make it short.");
    await new Promise((r) => setTimeout(r, 500));
    const stoppedAt = Date.now();
    await s.interrupt();
    await done;
    await new Promise((r) => setTimeout(r, 300)); // the stop path hands text back just after idle
    const notices = s.state.cells.filter((c: any) => c.kind === "notice").map((c: any) => c.text);
    expect(notices.some((t: string) => t.includes("Couldn't reach"))).toBe(true);
    expect(notices.at(-1)).toBe("Interrupted. Tell Atlarix what to do instead.");
    expect(s.state.lastError).toBeNull();
    // Never lost (QA): a retry that took it shows it in the transcript; one
    // that never got that far hands it back to the input box.
    const shownAsSent = s.state.cells.some((c: any) => c.kind === "user" && c.text === "And make it short.");
    expect(shownAsSent || unsent.includes("And make it short.")).toBe(true);
    // The stop ends it now, not after the remaining retries.
    expect(Date.now() - stoppedAt).toBeLessThan(8_000);
  }, 90_000);

  it("a message typed during a retry reaches the model on the try that works", async () => {
    // Two 503s, then the real fake model: the second request takes the message
    // and fails; the third must still carry it (QA: it was lost with the second).
    const llm = startFakeLlm([{ text: "Short it is." }]);
    const bodies: string[] = [];
    let firstRequestReceived: (() => void) | null = null;
    const firstRequestPromise = new Promise<void>((r) => (firstRequestReceived = r));
    const srv = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.text();
        if (!new URL(req.url).pathname.endsWith("/chat/completions")) return fetch(new URL(new URL(req.url).pathname, llm.url.replace(/\/v1$/, "")), { method: req.method, headers: req.headers });
        bodies.push(body);
        if (bodies.length === 1) firstRequestReceived?.();
        if (bodies.length <= 2) return new Response("overloaded", { status: 503 });
        return fetch(`${llm.url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body });
      },
    });
    const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
    const model = await seedDevProvider({ baseUrl: `http://127.0.0.1:${srv.port}/v1`, model: "fake-model", apiKey: "dev" });
    const s = new AgentSession({ workspaceDir: ws, model });
    await s.start();
    const done = new Promise<void>((resolve) => {
      const check = (st: { busy: boolean }) => {
        if (!st.busy) {
          s.off("change", check);
          resolve();
        }
      };
      setTimeout(() => s.on("change", check), 50);
    });
    await s.submit("Write a poem.");
    // Wait for the first 503 to be received, then submit during the retry wait.
    await firstRequestPromise;
    // Give a small buffer for the retry wait to start (CI can be slow).
    await new Promise((r) => setTimeout(r, 200));
    await s.submit("And make it short.");
    await done;
    srv.stop(true);
    expect(bodies.length).toBe(3);
    expect(bodies[2]).toContain("And make it short.");
    expect(s.state.lastError).toBeNull();
  }, 60_000);
});
