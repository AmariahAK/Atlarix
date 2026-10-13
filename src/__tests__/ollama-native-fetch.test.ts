import { afterEach, describe, expect, it, vi } from "vitest";
import { ollamaNativeFetch, toNativeMessages, toNativeRequest, toOpenAiStream } from "@/ipc/utils/ollama_native_fetch";

const enc = new TextEncoder();
function ndjson(lines: object[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      // Split mid-line on purpose: lines arrive in pieces.
      const all = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
      c.enqueue(enc.encode(all.slice(0, 17)));
      c.enqueue(enc.encode(all.slice(17)));
      c.close();
    },
  });
}
async function sse(stream: ReadableStream<Uint8Array>): Promise<Array<Record<string, any>>> {
  const text = await new Response(stream).text();
  return text
    .split("\n\n")
    .filter((b) => b.startsWith("data: ") && !b.includes("[DONE]"))
    .map((b) => JSON.parse(b.slice(6)));
}

afterEach(() => vi.restoreAllMocks());

describe("Ollama through its native API", () => {
  it("sends the model's window as num_ctx (the /v1 endpoint ignores it)", () => {
    const r = toNativeRequest({ model: "qwen2.5:3b", messages: [{ role: "user", content: "hi" }], stream: true, max_tokens: 50, temperature: 0.2 }, 32768);
    expect(r).toMatchObject({ model: "qwen2.5:3b", stream: true, options: { num_ctx: 32768, num_predict: 50, temperature: 0.2 } });
  });

  it("converts messages: images as base64, tool calls with object arguments, tool results by name", () => {
    const out = toNativeMessages([
      { role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "export const a = 1" },
    ]);
    expect(out[0]).toEqual({ role: "user", content: "what is this", images: ["AAAA"] });
    expect(out[1]).toEqual({ role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "a.ts" } } }] });
    expect(out[2]).toEqual({ role: "tool", content: "export const a = 1", tool_name: "read_file" });
  });

  it("streams back as OpenAI chunks: thinking, text, tool calls, and token counts", async () => {
    const chunks = await sse(
      toOpenAiStream(
        ndjson([
          { message: { thinking: "Need the file." } },
          { message: { content: "Reading" } },
          { message: { content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "src/math.ts" } } }] } },
          { message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 13829, eval_count: 42 },
        ]),
        "qwen2.5:3b",
      ),
    );
    expect(chunks[0].choices[0].delta).toEqual({ reasoning_content: "Need the file." });
    expect(chunks[1].choices[0].delta).toEqual({ content: "Reading" });
    const call = chunks[2].choices[0].delta.tool_calls[0];
    expect(call).toMatchObject({ index: 0, type: "function", function: { name: "read_file", arguments: '{"path":"src/math.ts"}' } });
    const last = chunks.at(-1)!;
    expect(last.choices[0].finish_reason).toBe("tool_calls");
    expect(last.usage).toEqual({ prompt_tokens: 13829, completion_tokens: 42, total_tokens: 13871 });
  });

  it("routes only chat to /api/chat with num_ctx from /api/show, and passes Ollama's errors through", async () => {
    const calls: Array<{ url: string; body?: any }> = [];
    const inner = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/api/show")) return new Response(JSON.stringify({ parameters: "", model_info: { "qwen2.context_length": 131072 } }));
      if (url.endsWith("/api/chat")) return new Response(JSON.stringify({ error: "model 'nope' not found" }), { status: 404 });
      return new Response("{}");
    });
    vi.stubGlobal("fetch", inner);
    const f = ollamaNativeFetch("http://127.0.0.1:11434", inner as unknown as typeof fetch);
    const res = await f("http://127.0.0.1:11434/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "big:model", messages: [{ role: "user", content: "x" }], stream: true }) });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.message).toBe("Ollama: model 'nope' not found");
    const chat = calls.find((c) => c.url.endsWith("/api/chat"))!;
    // A 128k model runs at the 32k cap unless its Modelfile says otherwise.
    expect(chat.body.options.num_ctx).toBe(32768);
    await f("http://127.0.0.1:11434/v1/models");
    expect(calls.at(-1)!.url).toBe("http://127.0.0.1:11434/v1/models");
  });
});
