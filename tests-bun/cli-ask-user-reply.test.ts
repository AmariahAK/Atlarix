/**
 * A reply that ends by asking the user (ask_user) keeps what it said before the
 * question once the answer is sent: on screen, and in what the model is sent
 * next. Main saved that reply as the bare questions marker, so a drafted commit
 * message and PR text vanished from the CLI the moment the user answered, and
 * the model carried on without them (owner, 2026-10-16).
 *
 * The question comes from a REAL ask_user call in the same step as the prose,
 * as models send it; the fake model here can mix the two, fake-llm.ts can't.
 */
import { beforeAll, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const enc = new TextEncoder();
const base = { id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model" };
const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
const sent: Array<{ messages: unknown[] }> = [];
let url = "";

function sse(chunks: object[]): Response {
  const body = new ReadableStream({
    async start(c) {
      for (const ch of chunks) {
        c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
        await Bun.sleep(5);
      }
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const words = (t: string) => t.split(/(?<= )/).map((w) => ({ ...base, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] }));
const end = (reason: string) => ({ ...base, choices: [{ index: 0, delta: {}, finish_reason: reason }], usage });

beforeAll(() => {
  process.env.ATLARIX_USER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "cli-ask-ud-"));
  process.env.ATLARIX_CLI_DEV_PROVIDER = "1";
  process.env.ATLARIX_SURFACE = "cli";
  // ask_user ends its turn by aborting the stream; the AI SDK then rejects
  // promises nobody awaits (as in cli-session-commands.test.ts).
  process.on("unhandledRejection", () => {});
  let step = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
      const body = (await req.json()) as { messages: unknown[]; tools?: unknown[] };
      if (!body.tools?.length) return sse([...words("A title"), end("stop")]);
      sent.push(body);
      if (step++ === 0) {
        const ask = { name: "ask_user", arguments: JSON.stringify({ questions: [{ question: "Which branch?", options: ["fix/total", "main"] }] }) };
        return sse([
          ...words("Drafted commit message: fix the connz total. "),
          { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_q", type: "function", function: ask }] }, finish_reason: null }] },
          end("tool_calls"),
        ]);
      }
      return sse([...words("Pushing to fix/total."), end("stop")]);
    },
  });
  url = `http://127.0.0.1:${server.port}/v1`;
});

function waitFor(s: any, pred: (st: any) => boolean, ms = 30_000) {
  return new Promise<void>((resolve, reject) => {
    if (pred(s.state)) return resolve();
    const t = setTimeout(() => reject(new Error("condition never met")), ms);
    const check = (st: unknown) => {
      if (pred(st)) {
        clearTimeout(t);
        s.off("change", check);
        resolve();
      }
    };
    s.on("change", check);
  });
}

it("keeps the reply that asked, after the answer", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "cli-ask-ws-"));
  process.chdir(ws);
  await import("../src/headless/bundled-assets");
  const { AgentSession, seedDevProvider } = await import("../src/cli/agent/session");
  const model = await seedDevProvider({ baseUrl: url, model: "fake-model", apiKey: "dev" });
  const s = new AgentSession({ workspaceDir: ws, model });
  await s.start();
  const said = (st: any) => st.cells.some((c: any) => c.kind === "markdown" && String(c.text).includes("Drafted commit message"));

  await s.submit("commit and push");
  await waitFor(s, (st) => st.question != null && !st.busy);
  expect(said(s.state)).toBe(true);

  await s.answerQuestion(["fix/total"]);
  await waitFor(s, (st) => !st.busy && st.cells.some((c: any) => c.kind === "markdown" && String(c.text).includes("Pushing")));
  expect(said(s.state)).toBe(true);
  // The saved reply draws the question as asked, not as still running (the
  // desktop parses the row; the CLI marks it done from its own tool event).
  const { getStreamTransport } = await import("../src/lib/chat/stream-transport");
  const { parseAssistantMessageParts } = await import("../src/lib/chat/assistant-message-parts");
  const row = getStreamTransport(s.chatId)!.messages.find((m: any) => m.role === "assistant" && m.content.includes("Drafted commit message"))!;
  const ask = parseAssistantMessageParts(row.content, false).find((p: any) => p.type === "tool" && p.toolName === "ask_user") as any;
  expect(ask?.status).toBe("success");
  // …and the model was sent its own words with the answer.
  expect(JSON.stringify(sent.at(-1)!.messages)).toContain("Drafted commit message");
}, 60_000);
