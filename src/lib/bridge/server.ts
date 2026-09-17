/**
 * The desktop's end of the bridge: a local socket the relay connects back to.
 *
 * ══ WHO CALLS WHOM, WHICH IS BACKWARDS FROM WHAT IT LOOKS LIKE ══
 *
 * The desktop wants to drive the extension, but it cannot open the connection.
 * Chrome will only speak to a native messaging host it spawned itself, and it
 * spawns one when the EXTENSION asks. So the extension connects outward, the
 * relay dials this socket, and only then can requests travel the other way.
 *
 * That inversion is why `request()` can fail with "no browser is connected"
 * rather than "could not connect": there is nothing here to dial.
 *
 * ══ A UNIX SOCKET, NOT A LOOPBACK PORT ══
 *
 * Filesystem permissions are the whole access control. No port to discover or
 * race, nothing portscannable, no bearer token to mint and leak, and — on macOS
 * — no "accept incoming connections" firewall prompt, which a loopback listener
 * would raise on first launch and which users reasonably refuse.
 *
 * On Windows the equivalent is a named pipe, which Node's `net` serves through
 * the same API.
 *
 * ══ EVERY REQUEST IS CORRELATED, BECAUSE REPLIES CAN OVERTAKE ══
 *
 * Two reads issued together can come back in either order — the extension runs
 * them against different tabs and whichever page answers first wins. Matching
 * replies to requests by arrival order would silently swap two results, and the
 * model would reason about the wrong page with no error anywhere. So every
 * request carries an id and every reply is looked up by it.
 */

import net from "node:net";
import fs from "node:fs/promises";

import { FrameReader, MAX_TO_EXTENSION_BYTES, encodeFrame } from "./framing";

export interface BridgeRequest {
  id: string;
  op: string;
  args?: Record<string, unknown>;
}

export type BridgeReply =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

/** What the extension says when it first connects. */
export interface BridgeHello {
  type: "hello";
  extensionVersion?: string;
  /** Hash of the extension's sources — distinguishes rebuilds of one version. */
  buildId?: string;
  browser?: string;
  protocol?: number;
}

/** The protocol version this build speaks. Bumped only on a breaking change. */
export const BRIDGE_PROTOCOL = 1;

/** How long a request waits before the caller is told the browser went quiet. */
export const REQUEST_TIMEOUT_MS = 30_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Peer {
  socket: net.Socket;
  hello: BridgeHello | null;
  connectedAt: number;
}

export interface BridgeServerOptions {
  socketPath: string;
  /** Called when a browser connects and identifies itself. */
  onHello?: (hello: BridgeHello) => void;
  onLog?: (message: string) => void;
}

export class BridgeServer {
  private server: net.Server | null = null;
  private peers = new Set<Peer>();
  private pending = new Map<string, Pending>();
  private nextId = 1;

  constructor(private readonly opts: BridgeServerOptions) {}

  /**
   * Start listening, clearing a stale socket file first.
   *
   * A unix socket is a FILE, and a crash leaves it behind. Binding over it
   * fails with EADDRINUSE, which reads as "already running" and would have the
   * bridge permanently dead after one hard kill. The safe removal is to try
   * CONNECTING first: if something answers, another instance really is live and
   * this one must not steal the name; if the connect is refused, the file is
   * debris and can go.
   */
  async listen(): Promise<void> {
    if (this.server) return;

    // THE LIVENESS PROBE RUNS ON EVERY PLATFORM. Only the unlink below is
    // unix-specific. An earlier version guarded both together, which left
    // Windows with no explicit check at all — the OS still refused the second
    // bind, but as a bare `listen EADDRINUSE` instead of a sentence naming the
    // cause. Same protection, worse diagnosis, and it read as a missing feature.
    if (await isSocketLive(this.opts.socketPath)) {
      throw new Error(
        `another Atlarix is already listening on ${this.opts.socketPath}`,
      );
    }

    // A unix socket is a FILE and a crash leaves it behind; binding over it
    // fails EADDRINUSE, which reads as "already running" and would leave the
    // bridge dead after one hard kill. Safe to remove only because the probe
    // above just proved nothing is answering. A Windows named pipe has no
    // filesystem entry to remove.
    if (!this.opts.socketPath.startsWith("\\\\")) {
      await fs.rm(this.opts.socketPath, { force: true }).catch(() => {});
    }

    const server = net.createServer((socket) => this.accept(socket));
    server.on("error", (err) => this.log(`server error: ${err.message}`));

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });

    this.server = server;

    // 0600 AFTER binding — the mode is applied to the file the bind created, so
    // doing it earlier would chmod nothing. Between bind and chmod the socket
    // is umask-default; that window is microseconds and local-only, and the
    // alternative (bind inside a 0700 directory) buys little for the extra
    // moving part.
    if (!this.opts.socketPath.startsWith("\\\\")) {
      await fs.chmod(this.opts.socketPath, 0o600).catch(() => {});
    }
    this.log(`listening on ${this.opts.socketPath}`);
  }

  private accept(socket: net.Socket): void {
    const peer: Peer = { socket, hello: null, connectedAt: Date.now() };
    this.peers.add(peer);
    const reader = new FrameReader();

    socket.on("data", (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = reader.push(chunk);
      } catch (err) {
        // A desynchronised stream cannot be recovered — the framing has no
        // resynchronisation point. Dropping the connection is the only honest
        // move; the extension reconnects.
        this.log(`framing failed, dropping peer: ${String(err)}`);
        socket.destroy();
        return;
      }
      for (const message of messages) this.handle(peer, message);
    });

    const done = () => {
      this.peers.delete(peer);
      // Anything still waiting on THIS peer will never be answered. Failing it
      // now turns a permanent hang into an error the caller can report.
      if (this.peers.size === 0) {
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("the browser disconnected before it answered"));
          this.pending.delete(id);
        }
      }
    };
    socket.on("close", done);
    socket.on("error", done);
  }

  private handle(peer: Peer, message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const body = message as Record<string, unknown>;

    if (body.type === "hello") {
      peer.hello = body as unknown as BridgeHello;
      this.log(
        `browser connected: ${String(body.browser ?? "chromium")} ` +
          `extension ${String(body.extensionVersion ?? "?")} ` +
          `build ${String(body.buildId ?? "?")}`,
      );
      this.opts.onHello?.(peer.hello);
      return;
    }

    const id = typeof body.id === "string" ? body.id : null;
    if (!id) return;
    const waiting = this.pending.get(id);
    // An id we never issued, or one that already timed out. Dropped rather than
    // logged loudly: a reply arriving after its timeout is expected, not a bug.
    if (!waiting) return;

    this.pending.delete(id);
    clearTimeout(waiting.timer);
    if (body.ok === true) waiting.resolve(body.result);
    else {
      waiting.reject(
        new Error(typeof body.error === "string" ? body.error : "the extension reported a failure"),
      );
    }
  }

  /** Is a browser connected and has it said hello? */
  get connected(): boolean {
    return [...this.peers].some((p) => p.hello !== null);
  }

  /** What connected, for a status surface. */
  get peerInfo(): BridgeHello[] {
    return [...this.peers].flatMap((p) => (p.hello ? [p.hello] : []));
  }

  /**
   * Ask the extension to do something.
   *
   * THE MOST RECENT PEER WINS when several browsers are connected. Chrome and
   * Brave can both hold a port open, and there is no basis in the protocol for
   * preferring one — "the one the user most recently opened a panel in" is the
   * closest available proxy for "the one they mean". Documented rather than
   * hidden, because a two-browser user whose command lands in the other window
   * needs the answer to be findable.
   */
  async request(
    op: string,
    args: Record<string, unknown> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const peers = [...this.peers].filter((p) => p.hello !== null);
    if (peers.length === 0) {
      throw new Error(
        "no browser is connected to Atlarix. Open the Atlarix side panel in " +
          "Chrome, Brave or Edge — the browser opens this connection, the app " +
          "cannot open it from this side.",
      );
    }
    const peer = peers.reduce((a, b) => (b.connectedAt > a.connectedAt ? b : a));

    const id = `d${this.nextId++}`;
    const frame = encodeFrame({ id, op, args } satisfies BridgeRequest);

    // Chrome silently DROPS a message over 1 MB on the way to an extension.
    // Silently: no error, no callback, the request simply never arrives and the
    // caller waits out the timeout wondering what the page did.
    if (frame.length > MAX_TO_EXTENSION_BYTES) {
      throw new Error(
        `that request is ${Math.round(frame.length / 1024)} KB, over Chrome's ` +
          `1 MB limit for a message to an extension. It would be dropped with ` +
          `no error at all.`,
      );
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `the browser did not answer "${op}" within ${Math.round(timeoutMs / 1000)}s`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      peer.socket.write(frame);
    });
  }

  async close(): Promise<void> {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Atlarix is shutting down"));
    }
    this.pending.clear();
    for (const peer of this.peers) peer.socket.destroy();
    this.peers.clear();

    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    // The bind created a file; closing the server does not remove it. Left
    // behind, the next launch has to decide whether it is debris — which it can
    // (see `listen`), but leaving less for it to work out is cheaper.
    if (!this.opts.socketPath.startsWith("\\\\")) {
      await fs.rm(this.opts.socketPath, { force: true }).catch(() => {});
    }
  }

  private log(message: string): void {
    this.opts.onLog?.(`[bridge] ${message}`);
  }
}

/** Is something actually accepting connections on this path right now? */
function isSocketLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    const done = (live: boolean) => {
      probe.destroy();
      resolve(live);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
    setTimeout(() => done(false), 1_000);
  });
}
