/**
 * Atlarix Core, over the proxy. The extension's only model access.
 *
 * CORE ONLY, NO BYOK — deliberate, and it is what makes this a paid product
 * rather than a free client for someone else's key. The copy has to say so: the
 * desktop app's headline is "any model, your own key", and a user who discovers
 * the difference after installing reads it as a bait-and-switch.
 *
 * NO AI SDK. This package ships no dependencies, and the proxy speaks plain
 * OpenAI-compatible chat completions — a request, an SSE stream, and tool calls
 * assembled from deltas. That is a few hundred lines against a bundle a Web
 * Store reviewer would have to read through.
 *
 * THE LINEUP COMES FROM `GET /v1/models`, never from `core-models.json`. That
 * file is the source the proxy itself is configured from, but it is served from
 * a CDN that 503s about one request in ten — and the proxy's answer is the one
 * that is actually true for this caller right now.
 */

import { getAccessToken } from "../auth/sign-in";

/** Which surface is spending. See `core_proxy.ts` in the desktop for the rule. */
const SURFACE = "extension";

export interface CoreModel {
  id: string;
  /** `core-1` … `core-N`. The tier is what the user picks; the id is what ships. */
  tier: string;
  /**
   * The model's context window and output allowance, from the proxy's copy of
   * models.dev.
   *
   * `null` means THE CATALOG HAD NO ROW, which is not the same as zero. A caller
   * must treat it as unknown — hide the context bar, skip the budget check —
   * rather than render a conversation as 100% full on its first message.
   *
   * They come from the proxy for the same reason the lineup does: the numbers
   * move when the lineup moves, and a second copy is a copy that goes stale on
   * its own schedule.
   */
  contextWindow: number | null;
  maxOutputTokens: number | null;
  /**
   * models.dev `modalities.input`, lower-cased — `["text"]`, `["text","image"]`.
   *
   * Empty means unknown. Core 1 is GLM and is text-only, so this is the gate
   * that decides whether an image attachment is offered at all.
   */
  inputModalities: string[];
}

/**
 * One piece of a multimodal user message.
 *
 * THE OPENAI CONTENT-PARTS SHAPE, which is what the proxy forwards untouched —
 * it never rewrites `body.messages`, and its `/v1/responses` path already maps
 * `image_url` to `input_image`. So the extension speaks the same dialect the
 * desktop does and nothing in the middle has to learn a third one.
 *
 * `file` carries a PDF as a data URL. It is gated separately from images on
 * purpose: seeing an image and accepting a document are separate capabilities in
 * every catalog that reports both, and a model with vision routinely rejects a
 * document part.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

/** A turn's worth of conversation, in the shape the proxy forwards. */
export type CoreMessage =
  | { role: "system"; content: string }
  /**
   * A string for an ordinary message; parts when something is attached.
   *
   * BOTH SHAPES STAY LEGAL rather than normalising everything to parts. A plain
   * question is the overwhelming majority of messages, every existing stored
   * transcript holds strings, and a migration that rewrote them all would be a
   * lot of risk for a uniformity nobody benefits from.
   */
  | { role: "user"; content: string | ContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

/**
 * The readable text of a user message, whichever shape it is in.
 *
 * ONE HELPER, USED EVERYWHERE, because the alternative is six places each
 * deciding what a parts array means — and five of them getting it right. The
 * one that does not is `messageText` in the budget, where a `typeof content ===
 * "string"` check returns an empty string for a parts message: the context bar
 * would report a conversation carrying five megabytes of images as empty.
 *
 * An image and a document contribute their NAME, not their bytes. A data URL is
 * base64 and is not text the model reads as text; counting its length as
 * characters would overstate a small image by an order of magnitude. Their real
 * token cost is charged by the provider, and the usage anchor is what accounts
 * for it — see `context/calibration.ts`.
 */
export function userText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "file"
          ? `[attached ${part.file.filename}]`
          : "[attached image]",
    )
    .join("\n");
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * A refusal the user can act on, separated from an outage they cannot.
 *
 * The distinction is the whole point of this class. "Top up" and "try again in
 * a minute" are different instructions, and a client that renders both as
 * "something went wrong" makes the first one undiscoverable.
 */
export class CoreError extends Error {
  readonly status: number;
  readonly code: string;
  /** Set on a 402: what the balance would have to be. */
  readonly requiredCents?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    requiredCents?: number,
  ) {
    super(message);
    this.name = "CoreError";
    this.status = status;
    this.code = code;
    this.requiredCents = requiredCents;
  }

  /**
   * True when retrying the identical request could work.
   *
   * **`status === 0` IS THE IMPORTANT ONE, and it was missing.** A connection
   * that drops mid-stream never produces an HTTP status at all — `fetch`
   * rejects with a bare `TypeError: network error`, the loop wraps it as
   * `stream_failed` with status 0, and this getter said `false`. So the single
   * most retryable failure there is was classified as permanent, and the user
   * got a red "network error" one call before their answer.
   *
   * Everything else stays deliberate: a 402 is a decision about money and a 403
   * is a decision about the account. Retrying either is asking the same question
   * twice and being charged for the asking.
   */
  get retryable(): boolean {
    return this.status === 0 || this.status === 502 || this.status === 503;
  }
}

function coreErrorFrom(
  status: number,
  body: Record<string, unknown>,
): CoreError {
  const code = typeof body.error === "string" ? body.error : `http_${status}`;
  const required =
    typeof body.required_cents === "number" ? body.required_cents : undefined;

  // Every message here is written for the person reading it, not for a log. A
  // 402 that does not say what it would take is the blunt version of this.
  const message =
    code === "insufficient_credit"
      ? required !== undefined
        ? `Not enough credit to start a turn — you need at least ${formatCents(required)}.`
        : "Not enough credit to start a turn."
      : code === "account_banned"
        ? "This account cannot use Atlarix Core. Contact support if that is unexpected."
        : code === "model_not_permitted"
          ? `That model is not available on Core${typeof body.model === "string" ? ` (${body.model})` : ""}.`
          : code === "core_unavailable"
            ? "Atlarix Core is temporarily unavailable. Try again shortly."
            : status === 401
              ? "Your session expired. Sign in again."
              : `Core request failed (${code}).`;

  return new CoreError(status, code, message, required);
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Base URL of the proxy, already ending at `/v1`. */
function baseUrl(): string {
  const raw = __ATLARIX_CORE_PROXY_URL__.trim().replace(/\/+$/, "");
  return raw.endsWith("/v1") ? raw : `${raw}/v1`;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  if (!token) {
    throw new CoreError(401, "not_signed_in", "Sign in to use Atlarix Core.");
  }
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    // A LABEL on the ledger row, never a selector for an account — who pays
    // comes from the JWT above. It must be sent from the FIRST Core call this
    // surface ever makes: a ledger row cannot be re-attributed, so spend
    // recorded without it is indistinguishable from the desktop's forever.
    "X-Atlarix-Surface": SURFACE,
  };
}

/**
 * POST JSON to a proxy path and return the parsed body.
 *
 * EXISTS SO THE SURFACE HEADER AND THE ERROR MAPPING STAY IN ONE PLACE. The
 * connector tools would otherwise each build their own request, and the first
 * one to forget `X-Atlarix-Surface` would put its spend on the desktop's ledger
 * line permanently — a row cannot be re-attributed later.
 */
export async function coreProxyFetch<T>(
  path: string,
  payload: unknown,
  f: typeof fetch = fetch,
): Promise<T> {
  const res = await f(`${baseUrl()}${path}`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw coreErrorFrom(res.status, body);
  return body as T;
}

/**
 * The live Core lineup.
 *
 * Unauthenticated on the proxy, but sent with the session anyway so one code
 * path covers both and a signed-out user gets the same "sign in" message they
 * would get from anything else.
 */
export async function listModels(
  f: typeof fetch = fetch,
): Promise<CoreModel[]> {
  const res = await f(`${baseUrl()}/models`, { headers: await authHeaders() });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw coreErrorFrom(res.status, body);
  const data = Array.isArray(body.data) ? body.data : [];
  return data
    .filter(
      (m): m is Record<string, unknown> => typeof m === "object" && m !== null,
    )
    .map((m) => ({
      id: String(m.id ?? ""),
      tier: String(m.tier ?? ""),
      contextWindow: positiveOrNull(m.context_window),
      maxOutputTokens: positiveOrNull(m.max_output_tokens),
      inputModalities: Array.isArray(m.input_modalities)
        ? m.input_modalities.map((mod) => String(mod).toLowerCase())
        : [],
    }))
    .filter((m) => m.id);
}

/**
 * A catalog number, or null.
 *
 * Zero and negative collapse to null on purpose: an older proxy that does not
 * send these fields, and one that sends `0`, must both read as "unknown". A
 * window of 0 taken literally makes every conversation over budget.
 */
function positiveOrNull(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

/** One piece of a streamed turn. */
export type CoreEvent =
  /**
   * The model's thinking, where the model has any.
   *
   * DROPPED ENTIRELY UNTIL 2026-09-13, which is why the panel sat blank for
   * fifteen seconds on every turn and looked broken. GLM 5.3 is a reasoning
   * model: it emits its thinking first and its answer second, so the ONLY thing
   * arriving during the part of the turn a user is watching was a field this
   * client ignored.
   *
   * TWO SPELLINGS, because there is no standard. z.ai and DeepSeek send
   * `reasoning_content`; OpenRouter and several others send `reasoning`. Reading
   * one and not the other is the same blank panel for half the lineup.
   */
  | { type: "reasoning"; delta: string }
  | { type: "text"; delta: string }
  | { type: "tool-calls"; calls: ToolCall[] }
  /**
   * THE PROVIDER'S OWN TOKEN COUNT, from its own tokenizer.
   *
   * Arrives in the stream's FINAL frame, and it is exact where everything this
   * extension can compute for itself is an estimate. `prompt_tokens` covers the
   * entire request — system prompt, tool schemas and the whole transcript —
   * which is precisely the quantity the context bar and the compaction trigger
   * are trying to know.
   *
   * IT COSTS NOTHING TO HAVE. The proxy already forces
   * `stream_options: {include_usage: true}` because token counts are the only
   * basis for billing, and it tees the stream so every frame reaches the client
   * unchanged. The frame was arriving on every turn and being dropped on the
   * floor.
   */
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "done"; finishReason: string };

interface PartialToolCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Stream one model turn.
 *
 * TOOL CALLS ARRIVE AS FRAGMENTS, and assembling them is the fiddly part: the
 * name comes on the first delta for an index and the arguments accumulate as
 * raw JSON text across many. Anything that parses `arguments` before the stream
 * ends sees truncated JSON and throws on a call that was perfectly fine.
 */
export async function* streamTurn(
  args: {
    model: string;
    messages: CoreMessage[];
    tools?: ToolSchema[];
    maxOutputTokens?: number;
    signal?: AbortSignal;
  },
  f: typeof fetch = fetch,
): AsyncGenerator<CoreEvent> {
  const res = await f(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: await authHeaders(),
    signal: args.signal,
    body: JSON.stringify({
      model: args.model,
      messages: args.messages,
      stream: true,
      ...(args.tools?.length ? { tools: args.tools } : {}),
      ...(args.maxOutputTokens ? { max_tokens: args.maxOutputTokens } : {}),
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    throw coreErrorFrom(res.status, body);
  }
  if (!res.body) {
    throw new CoreError(
      502,
      "core_unavailable",
      "Core returned no response body.",
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // Indexed rather than keyed by id: the id itself arrives in a delta, and the
  // index is the only thing present on every fragment.
  const partial = new Map<number, PartialToolCall>();
  let finishReason = "stop";
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line, and a frame can straddle two
      // reads — so everything up to the last separator is complete and the
      // remainder stays buffered.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const line = frame
          .split("\n")
          .find((l) => l.startsWith("data:"))
          ?.slice(5)
          .trim();
        if (!line || line === "[DONE]") continue;

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // A malformed frame is not worth ending a turn over; the stream
          // recovers on the next one.
          continue;
        }

        // The usage frame carries no choices, so it must be read BEFORE the
        // `if (!choice) continue` below — which is exactly where the first
        // attempt at this lost it.
        if (payload.usage && typeof payload.usage === "object") {
          const u = payload.usage as Record<string, unknown>;
          const promptTokens =
            typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0;
          const completionTokens =
            typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
          if (promptTokens > 0) {
            yield { type: "usage", promptTokens, completionTokens };
          }
        }

        const choice = (
          payload.choices as Record<string, unknown>[] | undefined
        )?.[0];
        if (!choice) continue;
        if (typeof choice.finish_reason === "string") {
          finishReason = choice.finish_reason;
        }

        const delta = choice.delta as Record<string, unknown> | undefined;
        if (!delta) continue;

        // Thinking first: a reasoning model emits all of it before the answer
        // begins, so this is the whole of what the user can see early on.
        const reasoning =
          typeof delta.reasoning_content === "string"
            ? delta.reasoning_content
            : typeof delta.reasoning === "string"
              ? delta.reasoning
              : "";
        if (reasoning) {
          yield { type: "reasoning", delta: reasoning };
        }

        if (typeof delta.content === "string" && delta.content) {
          yield { type: "text", delta: delta.content };
        }

        const calls = delta.tool_calls as Record<string, unknown>[] | undefined;
        for (const call of calls ?? []) {
          const index = typeof call.index === "number" ? call.index : 0;
          const existing = partial.get(index) ?? { id: "", name: "", args: "" };
          const fn = call.function as Record<string, unknown> | undefined;
          partial.set(index, {
            id: typeof call.id === "string" && call.id ? call.id : existing.id,
            name:
              typeof fn?.name === "string" && fn.name ? fn.name : existing.name,
            args:
              existing.args +
              (typeof fn?.arguments === "string" ? fn.arguments : ""),
          });
        }
      }
    }
  } finally {
    // Releasing matters on an abort: an unreleased reader keeps the connection
    // open, and a cancelled turn that holds a socket is how the next one
    // mysteriously stalls.
    reader.releaseLock();
  }

  if (partial.size > 0) {
    yield {
      type: "tool-calls",
      calls: [...partial.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, c]) => ({
          // A provider that omits the id still needs one the tool result can
          // quote back, and the index is stable within a turn.
          id: c.id || `call_${index}`,
          type: "function" as const,
          function: { name: c.name, arguments: c.args },
        }))
        .filter((c) => c.function.name),
    };
  }

  yield { type: "done", finishReason };
}
