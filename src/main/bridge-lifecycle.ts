/**
 * Starting and stopping the desktop↔extension bridge, and finding the relay.
 *
 * ══ WHY THE RELAY PATH IS RESOLVED HERE AND NOT WHERE IT IS USED ══
 *
 * Because the answer differs between `npm start` and a packaged app, and the
 * packaged answer is the one that cannot be tested locally. `process.
 * resourcesPath` exists only after packaging; under `electron-forge start`
 * there is no such entry and the dev tree is the only place the binary is. Both
 * are checked, in that order, exactly as `sandbox/wrap-command.ts` resolves the
 * two Rust sandbox helpers — the pattern is established, and copying it means
 * the relay ships through infrastructure that already works rather than new
 * infrastructure that might.
 *
 * ══ EVERY FAILURE HERE IS NON-FATAL ══
 *
 * The bridge is an extra way to drive a browser, not a thing Atlarix needs to
 * open. A missing relay, an unwritable browser directory, a socket that will
 * not bind because another copy is already running — none of them may stop the
 * app starting. They are logged and the bridge stays down.
 */

import fs from "node:fs";
import path from "node:path";

import log from "electron-log";

import { BridgeServer, isSocketLive } from "@/lib/bridge/server";
import { BridgePeer, peersSocketPath } from "@/lib/bridge/peer";
import { chromePeer } from "@/lib/peers/chrome-peer";
import {
  bridgeSocketPath,
  hostEnvPath,
  installNativeHost,
  wrapperPath,
} from "@/lib/bridge/host-install";

const logger = log.scope("bridge");

/**
 * The relay binary, or null when this build does not carry one.
 *
 * `ATLARIX_BRIDGE_RELAY` first, so a developer can point at a debug build
 * without reinstalling host manifests.
 */
export function resolveRelayPath(): string | null {
  const override = process.env.ATLARIX_BRIDGE_RELAY;
  if (override && fs.existsSync(override)) return override;

  const name = process.platform === "win32" ? "atlarix-bridge.exe" : "atlarix-bridge";

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, name);
    if (fs.existsSync(packaged)) return packaged;
  }

  // Development. `app.getAppPath()` is not used: under forge it points into
  // .vite, and the crate's target directory is relative to the repo root.
  const dev = path.join(
    process.cwd(),
    "native",
    "atlarix-bridge",
    "target",
    "release",
    name,
  );
  return fs.existsSync(dev) ? dev : null;
}

/**
 * What the browser tools talk to: this process's own server (it HOSTS the
 * browser connection), or a peer link to the Atlarix process that does (the
 * desktop app and the CLI share one browser; see server.ts).
 */
export type BridgeEndpoint = Pick<BridgeServer, "connected" | "peerInfo" | "activeHello" | "request">;

let endpoint: BridgeEndpoint | null = null;
let role: "host" | "peer" | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let startOptions: StartBridgeOptions = {};
let stopping = false;

/** The live endpoint, for the tool layer to ask whether a browser is connected. */
export function bridge(): BridgeEndpoint | null {
  return endpoint;
}

/** Host (this process owns the browser connection) or peer (another Atlarix does). */
export function bridgeRole(): "host" | "peer" | null {
  return role;
}

export interface StartBridgeOptions {
  /** The relay to install for the browser to spawn. Default: this build's (resolveRelayPath). */
  relayPath?: string | null;
  /**
   * "if-missing": install the native host only when none is installed (the
   * CLI: the desktop app's install already points the browser at the same
   * socket, and its relay is the one to keep). Default "always" (the app).
   */
  installHost?: "always" | "if-missing";
}

/** A native host some Atlarix already installed, whose relay is still on disk. */
function nativeHostInstalled(): boolean {
  try {
    const env = fs.readFileSync(hostEnvPath(), "utf8");
    const relay = /^ATLARIX_BRIDGE_RELAY=(.*)$/m.exec(env)?.[1]?.trim();
    return Boolean(relay && fs.existsSync(relay) && fs.existsSync(wrapperPath()));
  } catch {
    return false;
  }
}

function scheduleRetry(ms: number): void {
  if (stopping || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void startBridge(startOptions).catch(() => {});
  }, ms);
  retryTimer.unref?.();
}

export async function startBridge(opts: StartBridgeOptions = {}): Promise<void> {
  if (endpoint) return;
  startOptions = opts;
  stopping = false;

  const relayPath = opts.relayPath !== undefined ? opts.relayPath : resolveRelayPath();
  if (!relayPath && !nativeHostInstalled()) {
    logger.info(
      "no relay binary in this build — the browser bridge is unavailable. " +
        "Build it with `cargo build --release` in native/atlarix-bridge.",
    );
    return;
  }

  const socketPath = bridgeSocketPath();
  try {
    // The browser as a session other sessions can message (peers/chrome-peer).
    // Only the host speaks for it: it holds the one connection to the browser.
    let hosted: BridgeServer | null = null;
    const browserSession = chromePeer(() => hosted);
    const next = new BridgeServer({
      socketPath,
      peersSocketPath: peersSocketPath(socketPath),
      onLog: (message) => logger.info(message),
      onHello: (hello, connection) => {
        logger.info(
          `browser attached: ${hello.browser ?? "chromium"} extension ${hello.extensionVersion ?? "?"} build ${hello.buildId ?? "?"}`,
        );
        browserSession.onHello(hello, connection);
      },
      onPeerGone: (hello, connection) => browserSession.onPeerGone(hello, connection),
      onExtRequest: (hello, op, args) => browserSession.onExtRequest(hello, op, args),
    });
    hosted = next;
    await next.listen();
    endpoint = next;
    role = "host";
  } catch (err) {
    // Another Atlarix (the app, or another CLI) already hosts the browser:
    // use it through that process instead.
    if (await isSocketLive(socketPath)) {
      await joinAsPeer(socketPath);
      return;
    }
    logger.warn(`bridge not listening: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (!relayPath || (opts.installHost === "if-missing" && nativeHostInstalled())) return;
  // AFTER the socket is up, never before. A browser that read the manifest and
  // dialled in between the two would get a connection refused and back off for
  // a minute, which on a fast machine is a real race rather than a theoretical
  // one.
  try {
    const install = await installNativeHost({ relayPath, socketPath });
    logger.info(
      `native host installed for ${install.manifests.length} browser profile(s)` +
        (install.registryKeys
          ? `, ${install.registryKeys.length} registry key(s)`
          : ""),
    );
    for (const { dir, reason } of install.skipped) {
      logger.warn(`could not write ${dir}: ${reason}`);
    }
  } catch (err) {
    logger.warn(
      `native host not installed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function joinAsPeer(socketPath: string): Promise<void> {
  const peer = new BridgePeer({
    socketPath: peersSocketPath(socketPath),
    onLog: (message) => logger.info(message),
    // The host quit: one of its peers takes the main socket. The jitter keeps
    // two peers from racing for it; the loser finds it live and joins as a peer.
    onHostGone: () => {
      endpoint = null;
      role = null;
      scheduleRetry(150 + Math.floor(Math.random() * 600));
    },
  });
  try {
    await peer.connect();
  } catch (err) {
    // An older Atlarix holds the socket and has no peers socket: no sharing
    // until it quits. Check back now and then.
    logger.warn(
      `another Atlarix holds the browser and does not share it (${err instanceof Error ? err.message : String(err)}) — retrying later`,
    );
    scheduleRetry(30_000);
    return;
  }
  endpoint = peer;
  role = "peer";
  logger.info("using the browser through the Atlarix that hosts it");
}

export async function stopBridge(): Promise<void> {
  stopping = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const current = endpoint;
  endpoint = null;
  role = null;
  // The host manifests are deliberately LEFT IN PLACE. They point at a wrapper
  // that exits quietly when the app is not running, so a stale one costs a
  // process spawn and nothing else — and removing them on every quit would mean
  // a browser opened before Atlarix could never find the bridge at all.
  await (current as { close?: () => Promise<void> } | null)?.close?.();
}
