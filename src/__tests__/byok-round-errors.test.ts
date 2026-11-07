/**
 * How a round ends when your own provider says no (HANDOFF 2026-10-31 item 1):
 *
 * (a) A 429 from your provider is retried as before, but when the retries run
 *     out the turn ends with the rate-limit message onError recorded, not as a
 *     disconnect ("Couldn't reach … Check it's running and the address is
 *     right"). A round with nothing recorded (Atlarix's own, or a dead socket)
 *     still ends as a disconnect.
 * (b) An error the provider sent inside a 200 stream finishes the step, so the
 *     round resolves instead of throwing. When it produced nothing, it ends as
 *     the refusal onError already showed, not as an empty reply that is then
 *     saved as "Something went wrong".
 */
import { describe, expect, it, vi } from "vitest";

const { runStreamRoundWithEmptyOutputRetry } = await import("@/ipc/handlers/chat_stream/turn-runner/round-retry");
const { createStreamTurnContext } = await import("@/ipc/handlers/chat_stream/turn-context");
const { NetworkStreamDisconnectedError, RECONNECT_DELAYS_MS, PROVIDER_BUSY_DELAYS_MS } = await import(
  "@/ipc/handlers/chat_stream/network-retry"
);
const { ProviderRefusedRequestError } = await import("@/ipc/utils/no_usable_model_output");
const { byokLimitKind } = await import("@/shared/texts");

const substitute = () => Object.assign(new Error("No output generated."), { name: "AI_NoOutputGeneratedError" });
const rateLimited = () =>
  Object.assign(new Error("Rate limit reached for requests"), {
    name: "AI_APICallError",
    statusCode: 429,
    isRetryable: true,
    responseBody: '{"error":{"message":"Rate limit reached for requests","code":"rate_limit_exceeded"}}',
  });

/** A round the SDK ended with its "no output" stand-in, after onError recorded `rec`. */
function failedRound(rec: Record<string, () => unknown>) {
  const s = substitute();
  const r = {
    // eslint-disable-next-line require-yield
    fullStream: (async function* () {
      throw s;
    })(),
    finishReason: Promise.reject(s),
    getResumeMessages: () => [],
    ...rec,
  };
  r.finishReason.catch(() => {});
  return r;
}

/** A round whose only step finished with an in-stream error: nothing streamed. */
function erroredStep(rec: Record<string, () => unknown>) {
  return {
    fullStream: (async function* () {
      yield { type: "error", error: { message: "model auto/x not available" } };
    })(),
    finishReason: Promise.resolve("error"),
    getResumeMessages: () => [],
    ...rec,
  };
}

function run(runSimpleStream: () => Promise<unknown>, sent: Array<{ channel: string; payload: unknown }> = []) {
  return runStreamRoundWithEmptyOutputRetry(
    createStreamTurnContext(),
    {
      event: {
        sender: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }), isDestroyed: () => false },
      } as never,
    },
    {
      runSimpleStream: runSimpleStream as never,
      fullResponse: "",
      abortController: new AbortController(),
      chatId: 1,
      processResponseChunkUpdate: async ({ fullResponse }) => fullResponse,
    },
  );
}

/** Runs `p` with fake timers until it settles. */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  void p.finally(() => (done = true)).catch(() => {});
  for (let i = 0; i < 40 && !done; i++) await vi.advanceTimersByTimeAsync(20_000);
  return p;
}

describe("(a) your provider's 429, once the retries run out", () => {
  it("ends as the refusal onError recorded, with its message, not a disconnect", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const reported: unknown[] = [];
      const err = rateLimited();
      const runSimpleStream = vi.fn(async () =>
        failedRound({
          getRecordedNetworkError: () => err,
          reportRecordedLimit: () => {
            reported.push(err);
            return err;
          },
        }),
      );
      const outcome = await settle(run(runSimpleStream)).catch((e: unknown) => e);
      expect(outcome).toBeInstanceOf(ProviderRefusedRequestError);
      expect((outcome as InstanceType<typeof ProviderRefusedRequestError>).refusal).toBe(err);
      expect(outcome).not.toBeInstanceOf(NetworkStreamDisconnectedError);
      // Retried as before, then told once.
      expect(runSimpleStream).toHaveBeenCalledTimes(1 + RECONNECT_DELAYS_MS.length);
      expect(reported).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("with nothing recorded (Atlarix's own 429, a dead socket) it is still a disconnect", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const err = rateLimited();
      const runSimpleStream = vi.fn(async () =>
        failedRound({ getRecordedNetworkError: () => err, reportRecordedLimit: () => null }),
      );
      const outcome = await settle(run(runSimpleStream)).catch((e: unknown) => e);
      expect(outcome).toBeInstanceOf(NetworkStreamDisconnectedError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an in-stream rate limit on your key waits, retries, then ends with its message", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const busy = { error: { code: "rate_limit_exceeded", message: "Rate limit reached" } };
      const reported: unknown[] = [];
      const runSimpleStream = vi.fn(async () =>
        erroredStep({
          getRecordedBusy: () => busy,
          getRecordedLimit: () => busy,
          reportRecordedLimit: () => (reported.push(busy), busy),
        }),
      );
      const outcome = await settle(run(runSimpleStream)).catch((e: unknown) => e);
      expect(outcome).toBeInstanceOf(ProviderRefusedRequestError);
      expect(runSimpleStream).toHaveBeenCalledTimes(1 + PROVIDER_BUSY_DELAYS_MS.length);
      expect(reported).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("(b) an error inside a 200 stream", () => {
  it("that produced nothing ends as the refusal, asked once", async () => {
    const refusal = { error: { message: "model auto/x not available" } };
    const runSimpleStream = vi.fn(async () => erroredStep({ getRecordedRefusal: () => refusal }));
    const outcome = await run(runSimpleStream).catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(ProviderRefusedRequestError);
    expect((outcome as InstanceType<typeof ProviderRefusedRequestError>).refusal).toBe(refusal);
    expect(runSimpleStream).toHaveBeenCalledTimes(1);
  });

  it("after the round already did work, the round keeps it", async () => {
    const refusal = { error: { message: "model auto/x not available" } };
    const runSimpleStream = vi.fn(async () => ({
      ...erroredStep({ getRecordedRefusal: () => refusal }),
      getResumeMessages: () => [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "a", toolName: "grep", input: {} }] }],
    }));
    const outcome = await run(runSimpleStream);
    expect(outcome.finishReason).toBe("error");
  });

  it("a round with no refusal recorded finishes as before", async () => {
    const runSimpleStream = vi.fn(async () => erroredStep({}));
    const outcome = await run(runSimpleStream);
    expect(outcome.finishReason).toBe("error");
    expect(runSimpleStream).toHaveBeenCalledTimes(1);
  });
});

describe("byokLimitKind: one source for the message and the telemetry", () => {
  it.each([
    ["You exceeded your current quota, please check your plan and billing details.", "credit"],
    ['{"error":{"type":"insufficient_quota"}}', "credit"],
    ["Your credit balance is too low to access the Anthropic API.", "credit"],
    ["Insufficient Balance", "credit"],
    ["Rate limit reached for requests per minute", "rate"],
    ["Incorrect API key provided", "key"],
    ["model auto/x not available", null],
  ])("%s", (text, kind) => {
    expect(byokLimitKind(text)).toBe(kind);
  });
});
