/**
 * Your own provider's errors end the turn with what happened, by its words:
 * - a 429 that says the account is out of quota is the credit message, at once;
 * - a 429 rate limit is retried, then the rate-limit message;
 * - an error sent inside a 200 stream is that error, asked once.
 * Never "Couldn't reach … Check it's running" (a 429 is an answer, not a dead
 * address) and never "Something went wrong" over the provider's own reason
 * (HANDOFF 2026-10-31 item 1, fixes a and b).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BYOK_CREDIT_MARKER, BYOK_RATE_MARKER } from "../src/shared/texts";

let ws: string;

beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "byok-err-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "byok-err-ws-"));
});

/** A provider that answers every turn request with `answer`; counts them. */
function provider(answer: () => Response) {
  const turnRequests: string[] = [];
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("{ }", { status: 404 });
      const body = await req.text();
      if (body.includes('"tools"')) turnRequests.push(body);
      return answer();
    },
  });
  return { url: `http://127.0.0.1:${srv.port}/v1`, turnRequests, stop: () => srv.stop(true) };
}

type Session = InstanceType<typeof import("../src/cli/agent/session").AgentSession>;
/** The "retrying in Ns" lines the last session showed. */
const retryLines: string[] = [];

async function runTurn(baseUrl: string, timeoutMs: number, keep?: { session?: Session }) {
  const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
  const model = await seedDevProvider({ baseUrl, model: "fake-model", apiKey: "dev" });
  const s = new AgentSession({ workspaceDir: ws, model });
  if (keep) keep.session = s;
  await s.start();
  s.on("change", (st: { retrying?: string | null }) => void (st.retrying && retryLines.push(st.retrying)));
  return sendAndWait(s, "say hi", timeoutMs);
}

async function sendAndWait(s: Session, text: string, timeoutMs: number) {
  await s.submit(text);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`turn never finished: ${JSON.stringify(s.state.lastError)}`)), timeoutMs);
    const check = () => {
      if (!s.state.busy && s.state.lastError) {
        clearTimeout(t);
        resolve();
      }
    };
    s.on("change", check);
    check();
  });
  // What the screen shows: the error and every cell of the transcript.
  await new Promise((r) => setTimeout(r, 300));
  const cells = (s.state.cells as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
  return `${s.state.lastError ?? ""}\n${cells}`;
}

describe("your own provider's errors", () => {
  it("a 429 that says the quota is used up ends with the credit message, without retrying", async () => {
    const p = provider(() =>
      Response.json(
        {
          error: {
            code: 429,
            message: "You exceeded your current quota, please check your plan and billing details.",
            status: "RESOURCE_EXHAUSTED",
          },
        },
        { status: 429 },
      ),
    );
    try {
      const error = await runTurn(p.url, 40_000);
      expect(error).toContain(BYOK_CREDIT_MARKER);
      expect(error).not.toContain("Couldn't reach");
      expect(error).not.toContain("Something went wrong");
      expect(p.turnRequests.length).toBe(1);
    } finally {
      p.stop();
    }
  }, 45_000);

  it("a 429 rate limit is retried, then ends with the rate-limit message", async () => {
    const p = provider(() =>
      Response.json(
        { error: { message: "Rate limit reached for requests per minute", type: "requests", code: "rate_limit_exceeded" } },
        { status: 429 },
      ),
    );
    try {
      retryLines.length = 0;
      const error = await runTurn(p.url, 60_000);
      // The wait says what it is: the provider answered.
      expect(retryLines.some((l) => /^Rate-limited, retrying in \d+s \(1\/3\)/.test(l))).toBe(true);
      expect(retryLines.some((l) => l.includes("Couldn't connect"))).toBe(false);
      expect(error).toContain(BYOK_RATE_MARKER);
      expect(error).not.toContain("Couldn't reach");
      expect(error).not.toContain("Something went wrong");
      expect(p.turnRequests.length).toBeGreaterThan(1);
    } finally {
      p.stop();
    }
  }, 65_000);

  it("an error inside a 200 stream keeps its reason and is asked once", async () => {
    const p = provider(
      () =>
        new Response(`data: ${JSON.stringify({ error: { message: "model auto/x not available" } })}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    try {
      const keep: { session?: Session } = {};
      const error = await runTurn(p.url, 40_000, keep);
      expect(error).toContain("model auto/x not available");
      expect(error).not.toContain("Something went wrong");
      expect(p.turnRequests.length).toBe(1);
      // The failed turn left no "Something went wrong" reply in the chat: the
      // next request does not tell the model it said that.
      await sendAndWait(keep.session!, "try again", 40_000);
      expect(p.turnRequests.length).toBe(2);
      expect(p.turnRequests[1]).not.toContain("Something went wrong");
    } finally {
      p.stop();
    }
  }, 45_000);
});
