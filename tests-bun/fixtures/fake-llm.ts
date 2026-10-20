/**
 * A scripted OpenAI-compatible model for CLI tests (and for driving the TUI by
 * hand without spending credits: `bun tests-bun/fixtures/fake-llm.ts`).
 *
 * Each model request that offers tools gets the next reply from the script.
 * Auxiliary calls (no tools offered, e.g. titles) get a short text.
 */
export type Reply =
  | { tool: string; args: Record<string, unknown>; delayMs?: number }
  /** Several calls in one step (parallel tool calls). */
  | { tools: Array<{ tool: string; args: Record<string, unknown> }>; delayMs?: number }
  /** `waitMs`: nothing at all is sent for that long (a stop "before the first token"). */
  | { text: string; delayMs?: number; waitMs?: number };

const enc = new TextEncoder();
const base = { id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model" };
const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };

function sse(chunks: object[], delayMs = 0, waitMs = 0): Response {
  const body = new ReadableStream({
    async start(c) {
      if (waitMs) await Bun.sleep(waitMs);
      for (const ch of chunks) {
        c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
        if (delayMs) await Bun.sleep(delayMs);
      }
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function reply(r: Reply, n: number): Response {
  if ("tools" in r) {
    return sse(
      [
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: r.tools.map((t, k) => ({ index: k, id: `call_${n}_${k}_${t.tool}`, type: "function", function: { name: t.tool, arguments: JSON.stringify(t.args) } })),
              },
              finish_reason: null,
            },
          ],
        },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
      ],
      r.delayMs ?? 0,
    );
  }
  if ("tool" in r) {
    return sse(
      [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${n}_${r.tool}`, type: "function", function: { name: r.tool, arguments: JSON.stringify(r.args) } }] }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
      ],
      r.delayMs ?? 0,
    );
  }
  const words = r.text.split(/(?<= )/);
  return sse(
    [
      ...words.map((w) => ({ ...base, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] })),
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
    ],
    r.delayMs ?? 0,
    r.waitMs ?? 0,
  );
}

/** What a title or summary request gets back. */
export const AUX_TEXT = "A title";

export interface FakeLlm {
  url: string;
  /** Every request, titles included; a turn's own carry `tools`. */
  requests: Array<{ messages: Array<{ role: string; content: unknown }>; tools?: unknown[] }>;
  stop(): void;
}

export function startFakeLlm(script: Reply[], port = 0): FakeLlm {
  const requests: FakeLlm["requests"] = [];
  let step = 0;
  const server = Bun.serve({
    port,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("{}", { status: 404 });
      const body = (await req.json()) as { messages: FakeLlm["requests"][0]["messages"]; tools?: unknown[]; stream?: boolean };
      requests.push(body);
      // A request that is not streamed (a title, a summary) gets one JSON answer.
      if (body.stream !== true && !body.tools?.length) {
        return Response.json({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: AUX_TEXT }, finish_reason: "stop" }], usage });
      }
      if (!body.tools?.length) return reply({ text: "A title" }, 0);
      // One script step per model request that offers tools (a real turn step);
      // the last step repeats if the agent asks for more.
      const i = Math.min(step++, script.length - 1);
      return reply(script[i]!, i);
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 18787);
  startFakeLlm(
    [
      { tool: "grep", args: { pattern: "TODO" } },
      { tool: "run_command", args: { command: "ls", description: "list files" } },
      { text: "I searched for TODOs and listed the files. Everything looks fine.", delayMs: 40 },
    ],
    port,
  );
  console.log(`fake model on http://127.0.0.1:${port}/v1 (model id: fake-model)`);
}
