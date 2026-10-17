/**
 * A scripted endpoint on the Anthropic Messages API, for a provider the user
 * added with the Anthropic format. It takes the key in ONE header, as real
 * endpoints do (Anthropic: `x-api-key`; Bedrock and many gateways: Bearer), so
 * the client's choice of header is what gets tested.
 */
export interface FakeAnthropic {
  /** Base URL up to /v1, as a user types it. */
  url: string;
  requests: Array<{ method: string; path: string; headers: Record<string, string>; body: Record<string, unknown> | null }>;
  stop(): void;
}

const enc = new TextEncoder();

export function startFakeAnthropic(opts: {
  key: string;
  accepts: "x-api-key" | "bearer";
  reply?: string;
  /** Leave out GET /v1/models (Bedrock's endpoint has none). */
  noModelList?: boolean;
  port?: number;
}): FakeAnthropic {
  const requests: FakeAnthropic["requests"] = [];
  const authed = (h: Headers) =>
    opts.accepts === "bearer" ? h.get("authorization") === `Bearer ${opts.key}` : h.get("x-api-key") === opts.key;
  const denied = () =>
    Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 });

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      const body = req.method === "POST" ? ((await req.json().catch(() => null)) as Record<string, unknown> | null) : null;
      requests.push({ method: req.method, path: u.pathname, headers: Object.fromEntries(req.headers), body });
      if (req.method === "GET" && u.pathname === "/v1/models") {
        if (opts.noModelList) return new Response("<UnknownOperationException/>", { status: 404 });
        if (!authed(req.headers)) return denied();
        return Response.json({
          data: [{ type: "model", id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", max_input_tokens: 200000, max_tokens: 64000 }],
          has_more: false,
          first_id: "claude-haiku-4-5",
          last_id: "claude-haiku-4-5",
        });
      }
      if (req.method === "POST" && u.pathname === "/v1/messages") {
        if (!authed(req.headers)) return denied();
        const text = opts.reply ?? "Hello from the fake Anthropic endpoint.";
        const model = String(body?.model ?? "claude-haiku-4-5");
        const usage = { input_tokens: 12, output_tokens: 6 };
        if (!body?.stream) {
          return Response.json({
            id: "msg_fake",
            type: "message",
            role: "assistant",
            model,
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage,
          });
        }
        const events: Array<[string, object]> = [
          ["message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 6 } }],
          ["message_stop", { type: "message_stop" }],
        ];
        const stream = new ReadableStream({
          start(c) {
            for (const [name, data] of events) c.enqueue(enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
            c.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

/** By hand: `KEY=k ACCEPTS=bearer PORT=18788 bun tests-bun/fixtures/fake-anthropic.ts` (NO_LIST=1: no model list). */
if (import.meta.main) {
  const f = startFakeAnthropic({
    key: process.env.KEY ?? "fake-key",
    accepts: process.env.ACCEPTS === "x-api-key" ? "x-api-key" : "bearer",
    noModelList: process.env.NO_LIST === "1",
    port: Number(process.env.PORT ?? 18788),
  });
  console.log(`fake Anthropic-format endpoint on ${f.url} (key in ${process.env.ACCEPTS === "x-api-key" ? "x-api-key" : "Bearer"}; model claude-haiku-4-5)`);
}
