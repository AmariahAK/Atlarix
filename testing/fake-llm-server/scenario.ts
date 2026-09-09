import { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { createStreamChunk } from "./chunks";

/**
 * Multi-turn scenario support for the agent-eval harness (docs/TODO.md Tier 4).
 *
 * A scenario is an ordered list of scripted model responses — one per inbound
 * /v1/chat/completions request within an agent turn. The app embeds
 * `sc=<scenario-id>` in the first user message; the server keys a per-scenario
 * request counter on it and serves responses[step++], recording every raw
 * request body for message-shape assertions.
 *
 * Used two ways:
 * - in-process (vitest agent-evals): registerScenario()/getScenarioState()
 *   imported directly; the express app is mounted on an ephemeral port.
 * - over HTTP (e2e, debugging): POST /scenario, GET /scenario/:id/requests,
 *   POST /scenario/:id/reset via mountScenarioRoutes().
 */

export type ScenarioResponse =
  | {
      kind: "text";
      text: string;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    }
  | { kind: "tool_call"; calls: Array<{ name: string; args: unknown }> }
  | { kind: "error"; status: number; message?: string }
  /**
   * v14.8.7: emit one chunk (so the stream "started") then HANG — never ends.
   * Drives the idle-stall watchdog (stream_chunk_tags) → continue-from-partial
   * resume. Pair with a short ATLARIX_TEST_STALL_MS so the watchdog fires fast.
   */
  | { kind: "stall"; preText?: string }
  /**
   * HTTP 200, a well-formed stream, and an ERROR as the finish reason
   * (`finish_reason: "network_error"`) — the failure is in the body, not the
   * transport, so nothing at the HTTP layer can see it. Drives the
   * rawFinishReason guard in stream_chunk_tags → the existing silent retry.
   * Script a real response after it to assert the retry succeeds.
   */
  | { kind: "finish_reason"; reason: string; preText?: string }
  /**
   * Kill the TCP connection before a single byte of response — the REQUEST phase,
   * which nothing else here could express. `kind: "error"` is an HTTP status, so
   * headers have already arrived; `stall` hangs a healthy socket. Neither reaches
   * the code that handles a dead one.
   *
   * The fetch itself rejects, no step ever completes, and the SDK replaces the
   * transport error with a synthetic `NoOutputGeneratedError` — the shape that made
   * a reset surface to the user as a model that would not answer.
   *
   * Script a real response after it to assert the retry recovers.
   *
   * THERE IS DELIBERATELY NO MID-STREAM VARIANT, and both ways of writing one were
   * tried:
   * - Destroying the socket after a delta makes undici throw `TypeError:
   *   terminated` synchronously out of its own socket-close handler. That is an
   *   UNCAUGHT exception rather than a rejection, so no app code can catch it and
   *   every suite touching the primitive reports an unhandled error.
   * - Ending the response with no terminating chunk produces no error at all: the
   *   SDK accepts the truncated body as a complete answer, one request, clean
   *   finish. (Worth knowing on its own — that is silent truncation, the same class
   *   as the `finish_reason` case, and it is filed in docs/TODO.md.)
   *
   * The mid-stream phase is covered instead by `provider-finish-error.eval`, which
   * reaches the same network-retry branch through a throw of our own.
   */
  | { kind: "socket_reset"; when: "before_headers" };

export interface Scenario {
  id: string;
  responses: ScenarioResponse[];
  /**
   * When true and the step counter runs past the script, keep serving the
   * LAST response (e.g. loop-detection evals that need a tool call repeated
   * until the app-side guard aborts). Default: a clear 500 so a test that
   * under-scripted fails loudly instead of hanging on canned content.
   */
  repeatLast?: boolean;
}

interface ScenarioState {
  scenario: Scenario;
  step: number;
  requests: unknown[];
}

const scenarios = new Map<string, ScenarioState>();

export function registerScenario(scenario: Scenario): void {
  scenarios.set(scenario.id, { scenario, step: 0, requests: [] });
}

export function resetScenario(id: string): boolean {
  const state = scenarios.get(id);
  if (!state) return false;
  state.step = 0;
  state.requests = [];
  return true;
}

export function getScenarioState(
  id: string,
): { step: number; requests: unknown[] } | undefined {
  const state = scenarios.get(id);
  if (!state) return undefined;
  return { step: state.step, requests: state.requests };
}

export function clearScenarios(): void {
  scenarios.clear();
}

const SCENARIO_ID_RE = /\bsc=([A-Za-z0-9_-]+)\b/;

function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .filter((part: any) => part?.type === "text")
      .map((part: any) => String(part.text ?? ""))
      .join("\n");
  }
  return "";
}

/**
 * Returns the id of a REGISTERED scenario referenced by the messages, else
 * null. Scanned in REVERSE so the LIVE prompt (the last user message) wins:
 * multi-turn evals keep prior turns' `sc=` prompts in the request history,
 * and first-match scanning routed turn N to turn 1's exhausted scenario
 * (build evals only survived because the dynamic system tail leaked the
 * live id at messages[0]).
 */
export function findScenarioId(messages: any[]): string | null {
  for (const message of [...(messages ?? [])].reverse()) {
    const match = messageText(message).match(SCENARIO_ID_RE);
    if (match && scenarios.has(match[1])) return match[1];
  }
  return null;
}

function streamText(
  res: Response,
  content: string,
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  },
): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.write(createStreamChunk("", "assistant"));

  const batchSize = 64;
  let index = 0;
  const interval = setInterval(() => {
    if (index < content.length) {
      res.write(createStreamChunk(content.slice(index, index + batchSize)));
      index += batchSize;
    } else {
      res.write(createStreamChunk("", "assistant", true, usage));
      clearInterval(interval);
      res.end();
    }
  }, 2);
}

function streamToolCalls(
  res: Response,
  calls: Array<{ name: string; args: unknown }>,
): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const now = Date.now();
  const mkChunk = (delta: any, finish: null | string = null) => {
    const chunk = {
      id: `chatcmpl-${now}`,
      object: "chat.completion.chunk",
      created: Math.floor(now / 1000),
      model: "fake-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  };

  res.write(mkChunk({ role: "assistant" }));

  calls.forEach((call, index) => {
    res.write(
      mkChunk({
        tool_calls: [
          {
            index,
            id: `call_${now}_${index}`,
            type: "function",
            function: { name: call.name, arguments: "" },
          },
        ],
      }),
    );
    // Stream the arguments in a few slices to exercise the app's incremental
    // tool-input handling (same shape as the legacy calculator_add path).
    const args = JSON.stringify(call.args ?? {});
    const sliceSize = Math.max(8, Math.ceil(args.length / 4));
    for (let i = 0; i < args.length; i += sliceSize) {
      res.write(
        mkChunk({
          tool_calls: [
            { index, function: { arguments: args.slice(i, i + sliceSize) } },
          ],
        }),
      );
    }
  });

  res.write(mkChunk({}, "tool_calls"));
  res.write("data: [DONE]\n\n");
  res.end();
}

/** Serve one /v1/chat/completions request from the scenario script. */
export function handleScenarioChatCompletion(
  scenarioId: string,
  req: Request,
  res: Response,
): void {
  const state = scenarios.get(scenarioId);
  if (!state) {
    res.status(500).json({
      error: { message: `Scenario not registered: ${scenarioId}` },
    });
    return;
  }

  state.requests.push(req.body);

  let stepIndex = state.step;
  if (stepIndex >= state.scenario.responses.length) {
    if (state.scenario.repeatLast && state.scenario.responses.length > 0) {
      stepIndex = state.scenario.responses.length - 1;
    } else {
      res.status(500).json({
        error: {
          message:
            `Scenario "${scenarioId}" exhausted: request #${state.step + 1} ` +
            `but only ${state.scenario.responses.length} responses scripted. ` +
            `Add steps or set repeatLast.`,
        },
      });
      state.step++;
      return;
    }
  }
  state.step++;

  const response = state.scenario.responses[stepIndex];
  console.log(
    `* [scenario:${scenarioId}] serving step ${stepIndex} (${response.kind})`,
  );

  switch (response.kind) {
    case "text":
      streamText(res, response.text, response.usage);
      return;
    case "tool_call":
      streamToolCalls(res, response.calls);
      return;
    case "finish_reason": {
      // Deliberately a COMPLETE, well-formed stream: headers, a delta, a final
      // chunk, `[DONE]`. Everything is right except the reason — which is the
      // whole point, since a client that only inspects the transport sees a
      // clean success and silently truncates the turn.
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(createStreamChunk("", "assistant"));
      res.write(createStreamChunk(response.preText ?? "Partial answ"));
      res.write(
        createStreamChunk("", "assistant", true, undefined, response.reason),
      );
      res.end();
      return;
    }
    case "stall": {
      // Emit one delta (so hasReceivedChunk flips → the idle budget applies),
      // then hang: never write another chunk and never end. The client's stall
      // watchdog aborts the fetch; when it does, stop.
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(createStreamChunk("", "assistant"));
      res.write(createStreamChunk(response.preText ?? "Working"));
      req.on("close", () => {
        try {
          res.end();
        } catch {
          // already torn down
        }
      });
      return;
    }
    case "socket_reset":
      // Nothing written at all: no status, no headers, no body. The client's
      // fetch must reject before it can see a response, which is what makes this
      // the request phase rather than a 5xx.
      res.socket?.destroy();
      return;
    case "error":
      res.status(response.status).json({
        error: {
          message:
            response.message ?? `Scripted error (status ${response.status})`,
          type: response.status === 429 ? "rate_limit_error" : "scripted_error",
          param: null,
          code:
            response.status === 429 ? "rate_limit_exceeded" : "scripted_error",
        },
      });
      return;
  }
}

/** HTTP control surface (register / inspect / reset) for out-of-process callers. */
export function mountScenarioRoutes(app: {
  post: (route: string, handler: (req: Request, res: Response) => void) => void;
  get: (route: string, handler: (req: Request, res: Response) => void) => void;
}): void {
  app.post("/scenario", (req, res) => {
    const scenario = req.body as Scenario;
    if (!scenario?.id || !Array.isArray(scenario.responses)) {
      res.status(400).json({
        error: { message: "Scenario body must include id + responses[]" },
      });
      return;
    }
    registerScenario(scenario);
    res.json({ ok: true });
  });

  app.get("/scenario/:id/requests", (req, res) => {
    const state = getScenarioState(req.params.id);
    if (!state) {
      res.status(404).json({ error: { message: "Unknown scenario" } });
      return;
    }
    res.json({ step: state.step, requests: state.requests });
  });

  app.post("/scenario/:id/reset", (req, res) => {
    if (!resetScenario(req.params.id)) {
      res.status(404).json({ error: { message: "Unknown scenario" } });
      return;
    }
    res.json({ ok: true });
  });
}
