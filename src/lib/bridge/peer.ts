/**
 * Using the browser through ANOTHER Atlarix process (server.ts, "one browser,
 * several Atlarix processes"): the desktop app and the CLI share one browser
 * connection, and whichever started second reaches it here.
 *
 * Same surface as BridgeServer (`connected`, `activeHello`, `peerInfo`,
 * `request`), so the browser tools never know which side of the share they
 * are on. The host forwards each request through its own correlated
 * `request()`; this side only matches replies to its own ids.
 */
import net from "node:net";

import { FrameReader, encodeFrame } from "./framing";
import { REQUEST_TIMEOUT_MS, thisClient, type BridgeHello, type PeerStatus } from "./server";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** The peers socket beside the main one. */
export function peersSocketPath(main: string): string {
  return `${main}-peers`;
}

export class BridgePeer {
  private socket: net.Socket | null = null;
  private status: PeerStatus = { type: "status", connected: false, hellos: [] };
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly opts: {
      socketPath: string;
      /** The host went away (it quit): time to take over. */
      onHostGone?: () => void;
      onLog?: (message: string) => void;
    },
  ) {}

  /** Connect to the host; resolves once it has said what the browser is doing. */
  connect(timeoutMs = 2_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.opts.socketPath);
      const reader = new FrameReader();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error("the Atlarix sharing the browser did not answer"));
      }, timeoutMs);
      socket.on("data", (chunk: Buffer) => {
        let messages: unknown[];
        try {
          messages = reader.push(chunk);
        } catch {
          socket.destroy();
          return;
        }
        for (const m of messages) {
          this.handle(m);
          if (!settled && (m as { type?: string })?.type === "status") {
            settled = true;
            clearTimeout(timer);
            this.socket = socket;
            resolve();
          }
        }
      });
      socket.once("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      socket.on("close", () => {
        if (!settled) return;
        this.socket = null;
        this.status = { type: "status", connected: false, hellos: [] };
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("the Atlarix sharing the browser closed before it answered"));
          this.pending.delete(id);
        }
        if (!this.closed) {
          this.opts.onLog?.("[bridge] the host closed — taking over");
          this.opts.onHostGone?.();
        }
      });
    });
  }

  private handle(message: unknown): void {
    const body = (message ?? {}) as Record<string, unknown>;
    if (body.type === "status") {
      this.status = body as unknown as PeerStatus;
      return;
    }
    if (body.type !== "reply" || typeof body.id !== "string") return;
    const waiting = this.pending.get(body.id);
    if (!waiting) return;
    this.pending.delete(body.id);
    clearTimeout(waiting.timer);
    if (body.ok === true) waiting.resolve(body.result);
    else waiting.reject(new Error(typeof body.error === "string" ? body.error : "the extension reported a failure"));
  }

  get connected(): boolean {
    return this.socket != null && this.status.connected;
  }

  get peerInfo(): BridgeHello[] {
    return this.status.hellos;
  }

  get activeHello(): BridgeHello | null {
    return this.status.hellos.at(-1) ?? null;
  }

  /** Always true: this process reaches the browser through another one. */
  get shared(): boolean {
    return true;
  }

  request(op: string, args: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const socket = this.socket;
    if (!socket) {
      return Promise.reject(new Error("no browser is connected to Atlarix (the Atlarix sharing it has closed)."));
    }
    const id = `p${this.nextId++}`;
    return new Promise((resolve, reject) => {
      // A little longer than the host's own wait, so its timeout (with the
      // better message) arrives first.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the browser did not answer "${op}" within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs + 2_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(encodeFrame({ type: "request", id, op, args: { client: thisClient(), ...args }, timeoutMs }));
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.socket?.destroy();
    this.socket = null;
  }
}
