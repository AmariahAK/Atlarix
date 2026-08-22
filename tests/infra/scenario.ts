import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  registerScenario,
  resetScenario,
  getScenarioState,
  clearScenarios,
  type Scenario,
  type ScenarioResponse,
} from "../../testing/fake-llm-server/scenario";

export type { Scenario, ScenarioResponse };

/** Fluent builder for fake-LLM scenarios; embed `sc=<id>` in the eval prompt. */
export function scenario(id: string) {
  const responses: ScenarioResponse[] = [];
  let repeatLast = false;

  const builder = {
    text(text: string, usage?: Extract<ScenarioResponse, { kind: "text" }>["usage"]) {
      responses.push({ kind: "text", text, usage });
      return builder;
    },
    toolCall(name: string, args: unknown) {
      responses.push({ kind: "tool_call", calls: [{ name, args }] });
      return builder;
    },
    toolCalls(calls: Array<{ name: string; args: unknown }>) {
      responses.push({ kind: "tool_call", calls });
      return builder;
    },
    error(status: number, message?: string) {
      responses.push({ kind: "error", status, message });
      return builder;
    },
    /**
     * A 200 response whose finish reason IS the error — the silent-truncation
     * case. Script a real response next to assert the retry recovers.
     */
    finishReasonError(reason = "network_error", preText?: string) {
      responses.push({ kind: "finish_reason", reason, preText });
      return builder;
    },
    /** Emit one chunk then hang — drives the idle-stall watchdog (§A stall-resume). */
    stall(preText?: string) {
      responses.push({ kind: "stall", preText });
      return builder;
    },
    /** Keep serving the final response when the script runs out (loop evals). */
    repeatLast() {
      repeatLast = true;
      return builder;
    },
    build(): Scenario {
      return { id, responses, repeatLast };
    },
  };
  return builder;
}

export interface FakeLlmServer {
  /** OpenAI-compatible base for the seeded custom provider (…/v1). */
  baseURL: string;
  port: number;
  register(s: Scenario): void;
  reset(id: string): void;
  /** Raw request bodies the scenario received (message-shape assertions). */
  requestsFor(id: string): unknown[];
  stepFor(id: string): number;
  close(): Promise<void>;
}

/**
 * In-process fake-llm-server on an ephemeral port. Scenario state is shared
 * module state, so registration/inspection happen via direct imports — no
 * HTTP round-trips (the /scenario routes stay available for e2e).
 */
export async function startFakeLlmServer(): Promise<FakeLlmServer> {
  const { createApp } = await import("../../testing/fake-llm-server/app");
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://localhost:${port}/v1`,
    port,
    register: (s) => registerScenario(s),
    reset: (id) => {
      resetScenario(id);
    },
    requestsFor: (id) => getScenarioState(id)?.requests ?? [],
    stepFor: (id) => getScenarioState(id)?.step ?? 0,
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearScenarios();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
