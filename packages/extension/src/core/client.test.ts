/**
 * The Core client.
 *
 * TWO AREAS CARRY THE WEIGHT.
 *
 * **Tool-call assembly.** Calls arrive as fragments: the name lands on the first
 * delta for an index, the arguments accumulate as raw JSON text across many, and
 * the id may not appear at all. Anything that parses `arguments` early sees
 * truncated JSON and rejects a call that was perfectly well-formed. The
 * fragmenting here is deliberately awkward — split mid-key, mid-value, and
 * across SSE frame boundaries — because a stream that arrives in tidy whole
 * objects is the one case that never happens in production.
 *
 * **Error mapping.** "Top up" and "try again shortly" are different
 * instructions, and a client that renders both as "something went wrong" makes
 * the first undiscoverable. The 402 must carry the figure.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CoreError,
  freeLimitMessage,
  listModels,
  streamTurn,
  type CoreEvent,
} from "./client";
import { CREDIT_FIRST_LINE } from "./upgrade-line";

/** A signed-in session, so `getAccessToken` returns a token. */
function installFakeChrome() {
  const store = new Map<string, unknown>([
    [
      "atlarix.session.v1",
      {
        access_token: "at",
        refresh_token: "rt",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: "bearer",
        user: null,
      },
    ],
  ]);
  const area = {
    async get(key?: string | null) {
      return typeof key === "string" && store.has(key)
        ? { [key]: store.get(key) }
        : {};
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    async clear() {
      store.clear();
    },
  };
  (globalThis as Record<string, unknown>).chrome = {
    storage: { local: area, sync: area },
  };
  return store;
}

let store: Map<string, unknown>;
beforeEach(() => {
  vi.resetModules();
  store = installFakeChrome();
});

/** An SSE body from a list of raw frame payloads. */
function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= frames.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(frames[i]));
      i += 1;
    },
  });
}

function okStream(frames: string[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: true,
      status: 200,
      body: sseBody(frames),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
}

function failing(status: number, body: unknown) {
  return (async () =>
    ({
      ok: false,
      status,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

async function collect(gen: AsyncGenerator<CoreEvent>): Promise<CoreEvent[]> {
  const out: CoreEvent[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

const TURN = {
  model: "core-1",
  messages: [{ role: "user" as const, content: "hi" }],
};

describe("auth and attribution", () => {
  it("sends the bearer and X-Atlarix-Surface: extension", async () => {
    const { f, calls } = okStream(["data: [DONE]\n\n"]);
    await collect(streamTurn(TURN, f));
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer at");
    // The ledger label. It has to be on the FIRST Core call this surface ever
    // makes — a row cannot be re-attributed afterwards.
    expect(headers["X-Atlarix-Surface"]).toBe("extension");
  });

  it("refuses before the network when signed out", async () => {
    store.clear();
    const f = vi.fn() as unknown as typeof fetch;
    await expect(collect(streamTurn(TURN, f))).rejects.toThrow(/Sign in/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("listModels", () => {
  it("reads the live lineup from the proxy, not from core-models.json", async () => {
    const f = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          object: "list",
          data: [
            {
              id: "z-ai/glm-5.3",
              tier: "core-1",
              context_window: 200_000,
              max_output_tokens: 32_000,
              input_modalities: ["TEXT"],
            },
            { id: "openai/gpt-6-astra", tier: "core-3" },
          ],
        }),
      }) as unknown as Response) as unknown as typeof fetch;
    await expect(listModels(f)).resolves.toEqual([
      {
        id: "z-ai/glm-5.3",
        tier: "core-1",
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        // Lower-cased on the way in, so a caller compares against one spelling.
        inputModalities: ["text"],
      },
      // An entry with no catalog fields — an older proxy, or a model models.dev
      // has no row for. UNKNOWN, and it must stay distinguishable from zero: a
      // window of 0 taken literally puts every conversation over budget.
      {
        id: "openai/gpt-6-astra",
        tier: "core-3",
        contextWindow: null,
        maxOutputTokens: null,
        inputModalities: [],
      },
    ]);
  });

  it("treats a zero window as unknown rather than as a window of zero", async () => {
    const f = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "a/b", tier: "core-1", context_window: 0 }],
        }),
      }) as unknown as Response) as unknown as typeof fetch;
    expect((await listModels(f))[0].contextWindow).toBeNull();
  });

  it("drops entries with no id rather than surfacing a blank model", async () => {
    const f = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ tier: "core-9" }, null, "nope"] }),
      }) as unknown as Response) as unknown as typeof fetch;
    await expect(listModels(f)).resolves.toEqual([]);
  });
});

describe("streaming text", () => {
  it("yields each delta, then done with the finish reason", async () => {
    const { f } = okStream([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(await collect(streamTurn(TURN, f))).toEqual([
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("handles a frame split across two reads", async () => {
    // The decoder is streaming and the buffer holds a partial frame, so a chunk
    // boundary in the middle of the JSON must not lose it.
    const { f } = okStream([
      'data: {"choices":[{"delta":{"con',
      'tent":"split"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(await collect(streamTurn(TURN, f))).toContainEqual({
      type: "text",
      delta: "split",
    });
  });

  it("skips a malformed frame instead of ending the turn", async () => {
    const { f } = okStream([
      "data: {not json\n\n",
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(await collect(streamTurn(TURN, f))).toContainEqual({
      type: "text",
      delta: "ok",
    });
  });
});

describe("tool-call assembly", () => {
  it("reassembles a call whose arguments arrive in fragments", async () => {
    const { f } = okStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read_page","arguments":"{\\"fil"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ter\\":\\"inter"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"active\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);

    const events = await collect(streamTurn(TURN, f));
    const calls = events.find((e) => e.type === "tool-calls");
    expect(calls).toEqual({
      type: "tool-calls",
      calls: [
        {
          id: "call_a",
          type: "function",
          function: {
            name: "read_page",
            arguments: '{"filter":"interactive"}',
          },
        },
      ],
    });
    // And it parses — the whole reason not to parse early.
    const parsed = JSON.parse(
      (calls as { calls: Array<{ function: { arguments: string } }> }).calls[0]
        .function.arguments,
    ) as Record<string, unknown>;
    expect(parsed).toEqual({ filter: "interactive" });
  });

  it("keeps two concurrent calls apart by index", async () => {
    const { f } = okStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"one","arguments":"{}"}},{"index":1,"id":"b","function":{"name":"two","arguments":"{\\"x\\":1}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const calls = (await collect(streamTurn(TURN, f))).find(
      (e) => e.type === "tool-calls",
    ) as { calls: Array<{ id: string; function: { name: string } }> };
    expect(calls.calls.map((c) => [c.id, c.function.name])).toEqual([
      ["a", "one"],
      ["b", "two"],
    ]);
  });

  it("invents an id when the provider omits one", async () => {
    // The tool RESULT has to quote an id back. A call with none would produce a
    // message the model cannot match to anything it asked for.
    const { f } = okStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":2,"function":{"name":"solo","arguments":"{}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const calls = (await collect(streamTurn(TURN, f))).find(
      (e) => e.type === "tool-calls",
    ) as { calls: Array<{ id: string }> };
    expect(calls.calls[0].id).toBe("call_2");
  });

  it("emits no tool-calls event when there were none", async () => {
    const { f } = okStream([
      'data: {"choices":[{"delta":{"content":"just text"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const events = await collect(streamTurn(TURN, f));
    expect(events.some((e) => e.type === "tool-calls")).toBe(false);
  });
});

describe("errors say what to do about them", () => {
  it("says when Atlarix Auto's free share comes back, and does not retry it", async () => {
    const error = await collect(
      streamTurn(
        TURN,
        failing(429, { error: "free_usage_limit", retry_after_seconds: 7200 }),
      ),
    ).catch((e: CoreError) => e);
    expect((error as CoreError).message).toMatch(/free share is used up · resets at \d{1,2}:\d{2}/);
    expect((error as CoreError).message).toContain(CREDIT_FIRST_LINE);
    expect((error as CoreError).retryable).toBe(false);
  });

  it("names the reset on the user's clock — 00:00 UTC is 3:00 AM in Nairobi", () => {
    const midnightUtc = Date.UTC(2026, 8, 24);
    expect(
      freeLimitMessage({ retry_after_seconds: 7200 }, midnightUtc - 7200 * 1000, "Africa/Nairobi"),
    ).toMatch(/resets at 3:00\sAM/);
  });

  it("sends the routing hints, and never a free-consent header (paid-only surface)", async () => {
    const seen: Headers[] = [];
    const f = (async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response("data: [DONE]\n\n", { status: 200 });
    }) as unknown as typeof fetch;
    await collect(streamTurn({ ...TURN, purpose: "title" }, f)).catch(() => {});
    await collect(streamTurn(TURN, f)).catch(() => {});
    expect(seen[0]?.get("x-atlarix-purpose")).toBe("title");
    expect(seen[1]?.get("x-atlarix-purpose")).toBe("main");
    expect(seen[1]?.get("x-atlarix-mode")).toBe("build");
    for (const h of seen) expect(h.get("x-atlarix-free-consent")).toBeNull();
  });

  it("states the figure on insufficient credit", async () => {
    // A 402 that does not say what it would take is the blunt version of this.
    const f = failing(402, {
      error: "insufficient_credit",
      required_cents: 250,
    });
    await expect(collect(streamTurn(TURN, f))).rejects.toThrow(/\$2\.50/);
  });

  it("out of credit offers credit first, then Pro", async () => {
    const f = failing(402, { error: "insufficient_credit" });
    const error = await collect(streamTurn(TURN, f)).catch((e: CoreError) => e);
    const message = (error as CoreError).message;
    expect(message).toContain(CREDIT_FIRST_LINE);
    expect(message.indexOf("Add credit from $10")).toBeLessThan(message.indexOf("Atlarix Pro"));
  });

  it("does not tell a banned account to top up", async () => {
    const f = failing(403, { error: "account_banned" });
    const error = await collect(streamTurn(TURN, f)).catch((e: CoreError) => e);
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).message).not.toMatch(/credit|top up/i);
    expect((error as CoreError).retryable).toBe(false);
  });

  it("marks an outage retryable and a refusal not", async () => {
    const outage = await collect(
      streamTurn(TURN, failing(503, { error: "core_unavailable" })),
    ).catch((e: CoreError) => e);
    expect((outage as CoreError).retryable).toBe(true);

    const refusal = await collect(
      streamTurn(TURN, failing(402, { error: "insufficient_credit" })),
    ).catch((e: CoreError) => e);
    expect((refusal as CoreError).retryable).toBe(false);
  });

  it("tells an expired session to sign in again", async () => {
    const f = failing(401, {});
    await expect(collect(streamTurn(TURN, f))).rejects.toThrow(
      /Sign in again/i,
    );
  });
});

describe("thinking", () => {
  it("yields reasoning_content — the field z.ai and DeepSeek use", async () => {
    // DROPPED ENTIRELY UNTIL 2026-09-13. GLM 5.3 emits its thinking first and
    // its answer second, so ignoring this field left the panel blank for the
    // whole part of the turn a user is actually watching, and the product
    // looked broken on its default model.
    const { f } = okStream([
      'data: {"choices":[{"delta":{"reasoning_content":"Let me check"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Done."}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(await collect(streamTurn(TURN, f))).toEqual([
      { type: "reasoning", delta: "Let me check" },
      { type: "text", delta: "Done." },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("also yields `reasoning`, which is what OpenRouter calls the same thing", async () => {
    // There is no standard spelling. Reading one and not the other is the same
    // blank panel for half the lineup.
    const { f } = okStream([
      'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(await collect(streamTurn(TURN, f))).toContainEqual({
      type: "reasoning",
      delta: "thinking",
    });
  });

  it("keeps thinking separate from the answer in the same delta", async () => {
    // Some providers send both fields on one delta during the handover.
    const { f } = okStream([
      'data: {"choices":[{"delta":{"reasoning_content":"so","content":"Hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const events = await collect(streamTurn(TURN, f));
    expect(events[0]).toEqual({ type: "reasoning", delta: "so" });
    expect(events[1]).toEqual({ type: "text", delta: "Hi" });
  });
});
