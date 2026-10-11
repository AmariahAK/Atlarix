/**
 * Talking to the extension host: messages out, the host's messages in, and
 * `rpc` for Atlarix's own data (keys, past chats, MCP…), which the host
 * forwards to an allow-listed `_atlarix/*` method.
 */
import type { HostMessage, RpcMethod, ViewMessage } from "../src/protocol";

declare function acquireVsCodeApi(): { postMessage(m: ViewMessage): void };
const vscode = acquireVsCodeApi();

export const post = (m: ViewMessage) => vscode.postMessage(m);

/** An error from an rpc, with the agent's own reason and its data (e.g. `needsModel`). */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

let seq = 0;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: RpcError) => void }>();

export function rpc<T = unknown>(method: RpcMethod, params: Record<string, unknown> = {}): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
    post({ type: "rpc", id, method, params });
  });
}

type Handler = (m: HostMessage) => void;
const handlers: Handler[] = [];

/** Every message from the host (rpc answers are settled before handlers run). */
export function onHost(h: Handler): void {
  handlers.push(h);
}

window.addEventListener("message", (e: MessageEvent<HostMessage>) => {
  const m = e.data;
  if (m.type === "rpc-result") {
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.error) w.reject(new RpcError(m.error, m.data));
    else w.resolve(m.result);
    return;
  }
  for (const h of handlers) h(m);
});
