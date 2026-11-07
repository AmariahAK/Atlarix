/**
 * Why a turn failed, as one fixed word, from the error's shape. The old
 * `error_kind` was `http_<n>` or an Error class name, which could not say
 * "out of credit" from "bad request" or "prompt too long".
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", isPackaged: false },
}));

const { classifyTurnError, classifyTurnEnd } = await import(
  "@/lib/analytics/turn-end"
);
const {
  ASK_USER_STREAM_STOP,
  USER_CANCEL_STREAM_STOP,
  LOOP_REPETITION_STREAM_STOP,
  FORCE_TEXT_FINISH_STREAM_STOP,
} = await import("@/lib/stream/stream-stop-sentinels");
const { NetworkStreamDisconnectedError } = await import(
  "@/ipc/handlers/chat_stream/network-retry"
);
const { ProviderRefusedRequestError, EmptyModelOutputAfterRetryError } =
  await import("@/ipc/utils/no_usable_model_output");
const { ATLARIX_AUTH_REQUIRED_PREFIX } = await import("@/shared/auth_ipc");
const { UserFacingRefusal } = await import("@/shared/texts");
const { endedText } = await import("@/lib/peers/peers");

const api = (statusCode: number, responseBody = "") =>
  Object.assign(new Error("provider said something"), {
    name: "AI_APICallError",
    statusCode,
    responseBody,
  });
const live = () => new AbortController().signal;
const aborted = (reason: unknown) => {
  const c = new AbortController();
  c.abort(reason);
  return c.signal;
};

describe("classifyTurnError", () => {
  it.each([
    [api(401), "auth", 401],
    [api(403, '{"error":"account_banned"}'), "auth", 403],
    [new Error(`${ATLARIX_AUTH_REQUIRED_PREFIX} sign in`), "auth", undefined],
    [api(402, '{"error":"insufficient_credit"}'), "quota", 402],
    [
      api(429, '{"error":"free_usage_limit","retry_after_seconds":3600}'),
      "quota",
      429,
    ],
    [api(503, '{"error":"free_busy"}'), "rate_limit", 503],
    [api(429), "rate_limit", 429],
    [
      api(400, "This model's maximum context length is 128000 tokens"),
      "context_overflow",
      400,
    ],
    [api(400), "bad_request", 400],
    [api(422), "bad_request", 422],
    [api(504), "timeout", 504],
    [api(500), "provider_5xx", 500],
    [api(502), "provider_5xx", 502],
  ])("%#: status and the proxy's codes", (err, kind, status) => {
    const c = classifyTurnError(err);
    expect(c.kind).toBe(kind);
    expect(c.httpStatus).toBe(status);
  });

  it("the proxy's late in-stream error carries its status as `code`", () => {
    const late = {
      error: {
        type: "atlarix_late_error",
        code: 402,
        message: '{"error":"insufficient_credit"}',
      },
    };
    expect(classifyTurnError(late)).toEqual({ kind: "quota", httpStatus: 402 });
  });

  it("a refused request keeps its status: a rejected key is auth, not just 'refused' (QA, ai-2f)", () => {
    const rejected = api(
      401,
      '{"error":{"message":"Invalid API key provided","type":"authentication_error"}}',
    );
    expect(
      classifyTurnError(new ProviderRefusedRequestError({ error: rejected })),
    ).toEqual({ kind: "auth", httpStatus: 401 });
    expect(
      classifyTurnError(new ProviderRefusedRequestError(api(404))),
    ).toEqual({ kind: "provider_refused", httpStatus: 404 });
  });

  it("finds the status inside the SDK's wrappers", () => {
    const wrapped = Object.assign(new Error("RetryError"), {
      lastError: api(429),
    });
    expect(classifyTurnError(wrapped)).toEqual({
      kind: "rate_limit",
      httpStatus: 429,
    });
  });

  it("a provider that kept failing is that failure once the retries run out, not 'network'", () => {
    // Live check 2026-10-21: twelve 500s from the provider ended the turn as `network`, which
    // the crash report drops as expected, so a provider outage was never reported.
    expect(
      classifyTurnError(new NetworkStreamDisconnectedError("", api(500))),
    ).toEqual({ kind: "provider_5xx", httpStatus: 500 });
    expect(
      classifyTurnError(
        new NetworkStreamDisconnectedError("", { error: api(503) }),
      ),
    ).toEqual({
      kind: "provider_5xx",
      httpStatus: 503,
    });
    expect(
      classifyTurnError(new NetworkStreamDisconnectedError("", api(429))),
    ).toEqual({ kind: "rate_limit", httpStatus: 429 });
    // A real transport fault keeps its word.
    expect(
      classifyTurnError(
        new NetworkStreamDisconnectedError("", new TypeError("fetch failed")),
      ).kind,
    ).toBe("network");
  });

  it("classes without a status", () => {
    expect(
      classifyTurnError(new NetworkStreamDisconnectedError("x" as never)).kind,
    ).toBe("network");
    expect(classifyTurnError(new ProviderRefusedRequestError({})).kind).toBe(
      "provider_refused",
    );
    expect(classifyTurnError(new EmptyModelOutputAfterRetryError()).kind).toBe(
      "no_output",
    );
    expect(
      classifyTurnError(
        Object.assign(new Error("x"), { name: "ChatPromptSafetyError" }),
      ).kind,
    ).toBe("content_rejected");
    expect(
      classifyTurnError(Object.assign(new Error("x"), { name: "TimeoutError" }))
        .kind,
    ).toBe("timeout");
    expect(classifyTurnError(new TypeError("boom")).kind).toBe("other");
  });

  it("returns a word, never the message", () => {
    const c = classifyTurnError(
      api(400, "SECRET-PROMPT /Users/someone a@example.com"),
    );
    expect(JSON.stringify(c)).not.toMatch(/SECRET|Users|example/);
  });
});

describe("classifyTurnEnd", () => {
  it("names each ending", () => {
    expect(classifyTurnEnd(undefined, live())).toEqual({ outcome: "ok" });
    expect(
      classifyTurnEnd(new Error("x"), aborted(ASK_USER_STREAM_STOP)),
    ).toEqual({ outcome: "ask_user" });
    expect(
      classifyTurnEnd(
        new Error("x"),
        aborted(new DOMException(USER_CANCEL_STREAM_STOP, "AbortError")),
      ),
    ).toEqual({
      outcome: "stopped",
    });
    expect(
      classifyTurnEnd(undefined, aborted(LOOP_REPETITION_STREAM_STOP)),
    ).toEqual({
      outcome: "aborted",
      errorKind: "tool_loop",
    });
    expect(classifyTurnEnd(new Error("x"), aborted("something_else"))).toEqual({
      outcome: "aborted",
    });
    expect(classifyTurnEnd(api(401), live())).toEqual({
      outcome: "error",
      errorKind: "auth",
      httpStatus: 401,
    });
  });

  it('the person\'s own rule (a silk off, an edict) is a "rule" gate, named by its kind', () => {
    for (const rule of [
      "silk_off",
      "silk_scope",
      "silk_broken",
      "edict_stop",
    ] as const) {
      expect(classifyTurnEnd(new UserFacingRefusal("x", rule), live())).toEqual(
        {
          outcome: "gate",
          gateKind: "rule",
          errorKind: rule,
        },
      );
      expect(endedText("gate", rule)).toBe("stopped by a rule");
    }
    // The service's own gates keep their wording.
    expect(endedText("gate", "quota")).toMatch(/^paused: the free share/);
  });

  it("a refusal that is policy is a gate, not an error", () => {
    expect(
      classifyTurnEnd(
        api(429, '{"error":"free_usage_limit","retry_after_seconds":3600}'),
        live(),
      ),
    ).toEqual({
      outcome: "gate",
      gateKind: "free_usage_limit",
      errorKind: "quota",
      httpStatus: 429,
    });
    expect(
      classifyTurnEnd(api(503, '{"error":"free_busy"}'), live()),
    ).toMatchObject({ outcome: "gate", gateKind: "free_busy" });
    expect(
      classifyTurnEnd(
        api(402, '{"error":"insufficient_credit","required_cents":10}'),
        live(),
      ),
    ).toMatchObject({
      outcome: "gate",
      gateKind: "insufficient_credit",
    });
    // A plain 429 or 503 with no gate code is still a failure.
    expect(classifyTurnEnd(api(429), live())).toMatchObject({
      outcome: "error",
      errorKind: "rate_limit",
    });
    expect(classifyTurnEnd(api(503), live())).toMatchObject({
      outcome: "error",
    });
  });

  it("'wrap up now' that returned is a finished turn, not a stop", () => {
    expect(
      classifyTurnEnd(undefined, aborted(FORCE_TEXT_FINISH_STREAM_STOP)),
    ).toEqual({ outcome: "ok" });
  });
});
