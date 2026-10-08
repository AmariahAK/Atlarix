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
 *
 * ══ ONE BROWSER, SEVERAL ATLARIX PROCESSES ══
 *
 * The desktop app and the `atlarix` CLI can run at once, and both may want the
 * browser. Only one can own the socket the relay dials, so the first to start
 * HOSTS (this class) and also listens on a second, peers-only socket
 * (`peersSocketPath`). A later process finds the main socket live and connects
 * there as a peer (peer.ts): its requests are forwarded through the host's own
 * `request()`, so they share its correlation and timeouts, and each reply goes
 * back to the peer that asked. When the host exits, a peer takes over the main
 * socket and the extension's reconnect finds it there.
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
  /**
   * A random id the extension keeps for this browser profile (protocol 2+), so
   * the desktop can tell two profiles — or two browsers — apart and address one.
   */
  profileId?: string;
}

/**
 * The protocol version this build speaks.
 *
 * 2 adds ONE thing the extension may start: `{type:"ext-request", id, op, args}`,
 * answered with `{type:"ext-reply", id, ok, result | error}`. It is how the
 * extension's agent replies to a session that handed it a task (lib/peers/
 * chrome-peer.ts). Accepted only from a connection whose hello said protocol 2,
 * and only for the ops `onExtRequest` serves. A protocol-1 extension never
 * sends one, and a protocol-1 desktop drops it — the extension's call then
 * times out with a clear message rather than misbehaving.
 */
export const BRIDGE_PROTOCOL = 2;

/** How long a request waits before the caller is told the browser went quiet. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long a connection may sit silent before it is dropped.
 *
 * The extension sends its hello the instant the port opens, so a peer that has
 * said nothing after this long is not slow — it is a relay that cannot deliver.
 * The case that made this necessary: a relay stuck in a Windows pipe deadlock
 * held Chrome's port open forever, so the extension never reconnected and never
 * picked up the fixed relay. Dropping it breaks the relay's pipe read, the relay
 * exits, the port closes, and the extension's reconnect spawns a fresh host.
 */
export const HELLO_DEADLINE_MS = 10_000;

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
  /**
   * Called when a browser connects and identifies itself — again if it sends a
   * second hello on the same connection. `connection` is the same object for
   * every call about one connection (onPeerGone included).
   */
  onHello?: (hello: BridgeHello, connection: object) => void;
  onLog?: (message: string) => void;
  /** Override `HELLO_DEADLINE_MS` — tests only. */
  helloDeadlineMs?: number;
  /** Also serve other Atlarix processes here (see the docblock). */
  peersSocketPath?: string;
  /** A browser that had said hello disconnected. */
  onPeerGone?: (hello: BridgeHello, connection: object) => void;
  /**
   * Serve a request the extension started (protocol 2+). Whatever it returns is
   * the reply's result; a throw is the reply's error.
   */
  onExtRequest?: (
    hello: BridgeHello,
    op: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

/** What a host tells its peers about the browser. */
export interface PeerStatus {
  type: "status";
  connected: boolean;
  hellos: BridgeHello[];
}

export class BridgeServer {
  private server: net.Server | null = null;
  private peers = new Set<Peer>();
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private peersServer: net.Server | null = null;
  private peerClients = new Set<net.Socket>();

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
    if (this.opts.peersSocketPath) await this.listenForPeers(this.opts.peersSocketPath);
  }

  /** The socket other Atlarix processes use the browser through. */
  private async listenForPeers(socketPath: string): Promise<void> {
    if (!socketPath.startsWith("\\\\")) await fs.rm(socketPath, { force: true }).catch(() => {});
    const server = net.createServer((socket) => this.acceptPeerClient(socket));
    server.on("error", (err) => this.log(`peers socket error: ${err.message}`));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (err) {
      // The browser still works for this process; others just can't share it.
      this.log(`could not open the peers socket: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.peersServer = server;
    if (!socketPath.startsWith("\\\\")) await fs.chmod(socketPath, 0o600).catch(() => {});
  }

  private acceptPeerClient(socket: net.Socket): void {
    this.peerClients.add(socket);
    const reader = new FrameReader();
    socket.write(encodeFrame(this.status()));
    socket.on("data", (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const m of messages) {
        const body = (m ?? {}) as { type?: string; id?: string; op?: string; args?: Record<string, unknown>; timeoutMs?: number };
        if (body.type !== "request" || typeof body.id !== "string" || typeof body.op !== "string") continue;
        const id = body.id;
        this.request(body.op, body.args ?? {}, body.timeoutMs ?? REQUEST_TIMEOUT_MS).then(
          (result) => !socket.destroyed && socket.write(encodeFrame({ type: "reply", id, ok: true, result })),
          (err: unknown) =>
            !socket.destroyed &&
            socket.write(encodeFrame({ type: "reply", id, ok: false, error: err instanceof Error ? err.message : String(err) })),
        );
      }
    });
    const gone = () => this.peerClients.delete(socket);
    socket.on("close", gone);
    socket.on("error", gone);
  }

  private status(): PeerStatus {
    return { type: "status", connected: this.connected, hellos: this.peerInfo };
  }

  /** Tell every peer process the browser came or went. */
  private broadcastStatus(): void {
    if (this.peerClients.size === 0) return;
    const frame = encodeFrame(this.status());
    for (const c of this.peerClients) if (!c.destroyed) c.write(frame);
  }

  private accept(socket: net.Socket): void {
    const peer: Peer = { socket, hello: null, connectedAt: Date.now() };
    this.peers.add(peer);
    const reader = new FrameReader();

    const deadline = setTimeout(() => {
      if (peer.hello) return;
      this.log("peer sent no hello in time — dropping it so the browser reconnects");
      socket.destroy();
    }, this.opts.helloDeadlineMs ?? HELLO_DEADLINE_MS);
    deadline.unref?.();

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
      clearTimeout(deadline);
      if (!this.peers.has(peer)) return; // "error" and "close" both fire
      this.peers.delete(peer);
      if (peer.hello) this.opts.onPeerGone?.(peer.hello, peer);
      this.broadcastStatus();
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
      this.opts.onHello?.(peer.hello, peer);
      this.broadcastStatus();
      return;
    }

    if (body.type === "ext-request") {
      this.serveExtRequest(peer, body);
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

  /**
   * A request the extension started. Dropped, not answered, from a connection
   * that has not said hello with protocol 2 — an answer would tell an unknown
   * peer what this side serves.
   */
  private serveExtRequest(peer: Peer, body: Record<string, unknown>): void {
    const hello = peer.hello;
    const handler = this.opts.onExtRequest;
    if (!hello || (hello.protocol ?? 1) < 2 || !handler) return;
    const id = typeof body.id === "string" ? body.id : null;
    const op = typeof body.op === "string" ? body.op : null;
    if (!id || !op) return;
    const args =
      body.args && typeof body.args === "object"
        ? (body.args as Record<string, unknown>)
        : {};
    const reply = (frame: Record<string, unknown>) => {
      if (!peer.socket.destroyed)
        peer.socket.write(encodeFrame({ type: "ext-reply", id, ...frame }));
    };
    handler(hello, op, args).then(
      (result) => reply({ ok: true, result: result ?? null }),
      (err: unknown) =>
        reply({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
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
   * The hello of the browser a request goes to, so a caller can ask what that
   * extension build supports before asking it to do something. Web Store review
   * lags a desktop release by days, so an older extension is an ordinary state.
   */
  get activeHello(): BridgeHello | null {
    return this.newestPeer()?.hello ?? null;
  }

  /** The most recently connected peer that has said hello — the one requests use. */
  private newestPeer(): Peer | null {
    const peers = [...this.peers].filter((p) => p.hello !== null);
    if (peers.length === 0) return null;
    return peers.reduce((a, b) => (b.connectedAt > a.connectedAt ? b : a));
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
    /** Address one browser profile (its hello's `profileId`) instead of the newest. */
    target: { profileId?: string } = {},
  ): Promise<unknown> {
    const peer = target.profileId
      ? ([...this.peers]
          .filter((p) => p.hello?.profileId === target.profileId)
          .sort((a, b) => b.connectedAt - a.connectedAt)[0] ?? null)
      : this.newestPeer();
    if (!peer) {
      throw new Error(
        "no browser is connected to Atlarix. Open the Atlarix side panel in " +
          "Chrome, Brave or Edge — the browser opens this connection, the app " +
          "cannot open it from this side.",
      );
    }

    const id = `d${this.nextId++}`;
    // Which Atlarix is asking, so the extension keeps the app's and the CLI's
    // tabs in separate groups. A peer's request already carries its own.
    const frame = encodeFrame({ id, op, args: { client: thisClient(), ...args } } satisfies BridgeRequest);

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
    // Peers see their socket close and one of them takes over (peer.ts).
    for (const c of this.peerClients) c.destroy();
    this.peerClients.clear();
    const peersServer = this.peersServer;
    this.peersServer = null;
    if (peersServer) await new Promise<void>((resolve) => peersServer.close(() => resolve()));
    if (this.opts.peersSocketPath && !this.opts.peersSocketPath.startsWith("\\\\")) {
      await fs.rm(this.opts.peersSocketPath, { force: true }).catch(() => {});
    }

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

/** This process as the extension knows it: the `atlarix` CLI, or the app. */
export function thisClient(): "cli" | "app" {
  return process.env.ATLARIX_SURFACE === "cli" ? "cli" : "app";
}

/** Is something actually accepting connections on this path right now? */
export function isSocketLive(socketPath: string): Promise<boolean> {
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
