/**
 * Ollama through its native chat API, behind the OpenAI-compatible client.
 *
 * Ollama's OpenAI endpoint (`/v1/chat/completions`) ignores any context size
 * and runs every model at its default window (4096 on 0.40), so a prompt of a
 * few thousand tokens was cut to its tail: tools and instructions gone, no
 * local model could use tools (QA P1). Even a model preloaded with a larger
 * window is reloaded at the default by the next `/v1` request. Only the native
 * `/api/chat` honours `options.num_ctx`.
 *
 * So the client keeps speaking OpenAI, and this fetch turns each chat request
 * into a native one with the model's window, and the native reply (NDJSON)
 * back into OpenAI's (SSE or JSON), token counts included. Every other request
 * passes through untouched.
 */

/**
 * The window Atlarix asks Ollama for when the model's own Modelfile sets none.
 * The model's full window (128k for many) can need more memory than a laptop
 * has; 32k is what opencode's docs suggest for tool use. The context budget
 * uses the same number (resolve-model-context-limit.ts), so what Atlarix sends
 * always fits.
 */
export const OLLAMA_MAX_NUM_CTX = 32_768;

const numCtxCache = new Map<string, number | null>();
const ollamaAt = new Map<string, Promise<boolean>>();

/** "http://localhost:11434/v1" → "http://localhost:11434": where Ollama's native API lives. */
export function ollamaOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/(?:v1|api)$/, "");
}

/**
 * Whether an OpenAI-compatible address added as a custom provider is really
 * Ollama (its /api/version answers). Such a provider was run at Ollama's
 * default window, 4096, cutting the prompt (QA). Asked once per address.
 */
export function isOllamaEndpoint(baseUrl: string): Promise<boolean> {
  const origin = ollamaOrigin(baseUrl);
  let known = ollamaAt.get(origin);
  if (!known) {
    known = fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(1_500) })
      .then(async (r) => r.ok && typeof ((await r.json()) as { version?: unknown }).version === "string")
      .catch(() => false);
    ollamaAt.set(origin, known);
  }
  return known;
}

/**
 * The window to run `model` at: its Modelfile's `num_ctx` when it sets one
 * (the user chose it), else its trained context length capped at
 * OLLAMA_MAX_NUM_CTX. Null when Ollama can't say (the server's default stands).
 */
export async function ollamaNumCtx(base: string, model: string): Promise<number | null> {
  const key = `${base} ${model}`;
  if (numCtxCache.has(key)) return numCtxCache.get(key) ?? null;
  let n: number | null = null;
  try {
    const res = await fetch(`${base}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, name: model }),
      signal: AbortSignal.timeout(3_000),
    });
    if (res.ok) {
      const json = (await res.json()) as { parameters?: string; model_info?: Record<string, unknown> };
      const set = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(json.parameters ?? "");
      if (set) n = Number(set[1]);
      else {
        for (const [k, v] of Object.entries(json.model_info ?? {})) {
          if (k.endsWith("context_length") && typeof v === "number" && v > 0) {
            n = Math.min(v, OLLAMA_MAX_NUM_CTX);
            break;
          }
        }
      }
    }
  } catch {
    n = null;
  }
  numCtxCache.set(key, n);
  return n;
}

type OpenAiPart = { type: string; text?: string; image_url?: { url: string } | string };
type OpenAiToolCall = { id?: string; type?: string; function: { name: string; arguments?: string } };
type OpenAiMessage = {
  role: string;
  content?: string | OpenAiPart[] | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
  name?: string;
};
type OpenAiRequest = {
  model: string;
  messages: OpenAiMessage[];
  tools?: unknown[];
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  seed?: number;
  response_format?: { type: string; json_schema?: { schema?: unknown } };
};

type NativeToolCall = { function: { name: string; arguments: unknown } };
type NativeChunk = {
  message?: { content?: string; thinking?: string; tool_calls?: NativeToolCall[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

function parseArgs(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** OpenAI messages as Ollama's: images as base64, tool calls with object arguments, tool results by name. */
export function toNativeMessages(messages: OpenAiMessage[]): Array<Record<string, unknown>> {
  const toolNames = new Map<string, string>();
  return messages.map((m) => {
    let content = "";
    const images: string[] = [];
    if (typeof m.content === "string") content = m.content;
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === "text" && p.text) content += (content ? "\n" : "") + p.text;
        else if (p.type === "image_url") {
          const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
          const data = url && /^data:[^;]+;base64,(.*)$/s.exec(url)?.[1];
          if (data) images.push(data);
        }
      }
    }
    const out: Record<string, unknown> = { role: m.role, content };
    if (images.length) out.images = images;
    if (m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((c) => {
        if (c.id) toolNames.set(c.id, c.function.name);
        return { function: { name: c.function.name, arguments: parseArgs(c.function.arguments) } };
      });
    }
    if (m.role === "tool") {
      const name = (m.tool_call_id && toolNames.get(m.tool_call_id)) || m.name;
      if (name) out.tool_name = name;
    }
    return out;
  });
}

/** The native request for an OpenAI chat request, at `numCtx` when known. */
export function toNativeRequest(body: OpenAiRequest, numCtx: number | null): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (numCtx) options.num_ctx = numCtx;
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens != null) options.num_predict = maxTokens;
  if (body.temperature != null) options.temperature = body.temperature;
  if (body.top_p != null) options.top_p = body.top_p;
  if (body.seed != null) options.seed = body.seed;
  if (body.stop != null) options.stop = Array.isArray(body.stop) ? body.stop : [body.stop];
  const format =
    body.response_format?.type === "json_schema"
      ? body.response_format.json_schema?.schema
      : body.response_format?.type === "json_object"
        ? "json"
        : undefined;
  return {
    model: body.model,
    messages: toNativeMessages(body.messages),
    ...(body.tools?.length ? { tools: body.tools } : {}),
    stream: body.stream !== false,
    ...(format ? { format } : {}),
    ...(Object.keys(options).length ? { options } : {}),
  };
}

function usageOf(c: NativeChunk) {
  const prompt = c.prompt_eval_count ?? 0;
  const completion = c.eval_count ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function toolCallsOf(calls: NativeToolCall[], from: number) {
  return calls.map((c, i) => ({
    index: from + i,
    id: `call_${Date.now().toString(36)}_${from + i}`,
    type: "function" as const,
    function: {
      name: c.function.name,
      arguments: typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}),
    },
  }));
}

/** Ollama's NDJSON stream as OpenAI's SSE stream. */
export function toOpenAiStream(native: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const id = `chatcmpl-ollama-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) =>
    enc.encode(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`,
    );
  let calls = 0;
  let buf = "";
  const reader = native.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let c: NativeChunk;
          try {
            c = JSON.parse(line) as NativeChunk;
          } catch {
            continue;
          }
          if (c.error) {
            controller.error(new Error(`Ollama: ${c.error}`));
            return;
          }
          const m = c.message ?? {};
          let emitted = false;
          if (m.thinking) {
            controller.enqueue(chunk({ reasoning_content: m.thinking }));
            emitted = true;
          }
          if (m.content) {
            controller.enqueue(chunk({ content: m.content }));
            emitted = true;
          }
          if (m.tool_calls?.length) {
            controller.enqueue(chunk({ tool_calls: toolCallsOf(m.tool_calls, calls) }));
            calls += m.tool_calls.length;
            emitted = true;
          }
          if (c.done) {
            const finish = calls ? "tool_calls" : c.done_reason === "length" ? "length" : "stop";
            controller.enqueue(chunk({}, finish, usageOf(c)));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }
          if (emitted) return;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) {
          // The server closed without a final line: end the stream cleanly anyway.
          controller.enqueue(chunk({}, calls ? "tool_calls" : "stop"));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        buf += dec.decode(value, { stream: true });
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Ollama's whole (non-streamed) reply as OpenAI's. */
export function toOpenAiCompletion(c: NativeChunk, model: string): Record<string, unknown> {
  const m = c.message ?? {};
  const calls = m.tool_calls?.length ? toolCallsOf(m.tool_calls, 0).map(({ index: _i, ...rest }) => rest) : undefined;
  return {
    id: `chatcmpl-ollama-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: m.content ?? "", ...(m.thinking ? { reasoning_content: m.thinking } : {}), ...(calls ? { tool_calls: calls } : {}) },
        finish_reason: calls ? "tool_calls" : c.done_reason === "length" ? "length" : "stop",
      },
    ],
    usage: usageOf(c),
  };
}

/**
 * A fetch for the OpenAI-compatible client that sends chat requests to
 * Ollama's native API at `base` (e.g. http://127.0.0.1:11434).
 */
export function ollamaNativeFetch(base: string, inner: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!/\/chat\/completions(?:\?|$)/.test(url) || typeof init?.body !== "string") return inner(input, init);
    const body = JSON.parse(init.body) as OpenAiRequest;
    const numCtx = await ollamaNumCtx(base, body.model);
    const native = toNativeRequest(body, numCtx);
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    const res = await inner(`${base}/api/chat`, { ...init, headers, body: JSON.stringify(native) });
    if (!res.ok) {
      // Ollama's {"error": "..."} in the shape the client reads.
      const text = await res.text();
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // Not JSON: the text itself.
      }
      return new Response(JSON.stringify({ error: { message: `Ollama: ${message}`, type: "ollama_error" } }), {
        status: res.status,
        headers: { "content-type": "application/json" },
      });
    }
    if (native.stream && res.body) {
      return new Response(toOpenAiStream(res.body, body.model), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const whole = (await res.json()) as NativeChunk;
    return new Response(JSON.stringify(toOpenAiCompletion(whole, body.model)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
