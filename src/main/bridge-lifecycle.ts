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

import { BridgeServer } from "@/lib/bridge/server";
import { bridgeSocketPath, installNativeHost } from "@/lib/bridge/host-install";

const logger = log.scope("bridge");

let server: BridgeServer | null = null;

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

/** The live server, for the tool layer to ask whether a browser is connected. */
export function bridge(): BridgeServer | null {
  return server;
}

export async function startBridge(): Promise<void> {
  if (server) return;

  const relayPath = resolveRelayPath();
  if (!relayPath) {
    logger.info(
      "no relay binary in this build — the browser bridge is unavailable. " +
        "Build it with `cargo build --release` in native/atlarix-bridge.",
    );
    return;
  }

  const socketPath = bridgeSocketPath();
  try {
    const next = new BridgeServer({
      socketPath,
      onLog: (message) => logger.info(message),
      onHello: (hello) =>
        logger.info(
          `browser attached: ${hello.browser ?? "chromium"} extension ${hello.extensionVersion ?? "?"}`,
        ),
    });
    await next.listen();
    server = next;
  } catch (err) {
    // The commonest cause is a second Atlarix already listening, which is a
    // correct refusal rather than a fault. Either way the app opens.
    logger.warn(`bridge not listening: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // AFTER the socket is up, never before. A browser that read the manifest and
  // dialled in between the two would get a connection refused and back off for
  // a minute, which on a fast machine is a real race rather than a theoretical
  // one.
  try {
    const install = await installNativeHost({ relayPath, socketPath });
    logger.info(
      `native host installed for ${install.manifests.length} browser profile(s)`,
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

export async function stopBridge(): Promise<void> {
  const current = server;
  server = null;
  // The host manifests are deliberately LEFT IN PLACE. They point at a wrapper
  // that exits quietly when the app is not running, so a stale one costs a
  // process spawn and nothing else — and removing them on every quit would mean
  // a browser opened before Atlarix could never find the bridge at all.
  await current?.close();
}
