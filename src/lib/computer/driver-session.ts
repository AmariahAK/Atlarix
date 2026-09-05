/**
 * The `cua-driver` daemon: start it lazily, talk to it with one-shot `call`, stop
 * it on quit.
 *
 * WHY A DAEMON AT ALL, since `atlarix-sandbox` is spawn-run-exit. Because `call`
 * is not self-contained — its own help says "Invoke a single tool through the
 * **required** running daemon", and it proxies over a Unix socket (macOS/Linux) or
 * a named pipe (Windows). There is no `--direct` on `call`.
 *
 * WHY `serve --embedded` AND NOT `mcp --direct`. Both keep our TCC identity, but
 * `--embedded` also means no MCP client: no `StdioClientTransport`, no
 * `createMCPClient`, no protocol handling — just `execFile`, exactly the way
 * `src/lib/mobile/device-tools.ts` shells out to `adb`. Its documented contract is
 * "inherit the host's TCC grants, never prompt or relaunch", and the driver
 * confirms it at runtime: `call check_permissions` reports
 * `attribution: "host"`, `embedded: true`, `disclaim_env: false`. It also puts the
 * driver's own session cursor back in reach, because the overlay is `serve`-only.
 *
 * WHAT THIS IS MODELLED ON. `src/lib/pty/pty-session-manager.ts` — a module-level
 * handle, and a teardown that snapshots before it mutates. Deliberately NOT
 * `src/ipc/utils/mcp_manager.ts`: that has no `disposeAll` and is not in the quit
 * chain, so copying it would inherit a leak.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import log from "electron-log";
import { readSettings } from "@/main/settings";
import {
  missingBinaryMessage,
  resolveComputerBinary,
} from "./resolve-binary";

const logger = log.scope("computer-use");

/** How long to wait for `serve` to report itself running. */
const READY_TIMEOUT_MS = 20_000;
/** Poll interval while waiting for readiness. */
const READY_POLL_MS = 250;
/** Per-`call` ceiling. A read of a dense window is the slow case. */
const CALL_TIMEOUT_MS = 30_000;
/** macOS floor: upstream builds with MACOSX_DEPLOYMENT_TARGET=13.0. */
const MIN_MACOS_MAJOR = 13;

/**
 * Every reason the daemon can be unusable, as a discriminated value rather than a
 * bare throw — the tool layer maps these onto the four error-wording categories,
 * and getting the category wrong is what sends a model into a retry loop against a
 * permanent failure.
 */
export type ComputerUnavailable =
  | "disabled-by-setting"
  | "not-installed"
  | "unsupported-os-version"
  | "spawn-failed"
  | "not-ready"
  | "killed"
  /** A leftover socket from an unclean exit that we could not remove. */
  | "stale-socket";

export class ComputerUseError extends Error {
  constructor(
    readonly reason: ComputerUnavailable,
    message: string,
  ) {
    super(message);
    this.name = "ComputerUseError";
  }
}

let child: ChildProcess | null = null;
let ready = false;
/**
 * How many times we have spawned this session. The budget is TWO: the first start,
 * plus exactly one respawn after a crash. A counter rather than a boolean because
 * "have we respawned" is genuinely ambiguous while a start is in flight.
 */
let startCount = 0;
const MAX_STARTS = 2;
let starting: Promise<void> | null = null;

// ── telemetry, and why this is step one ──────────────────────────────────────

/**
 * cua-driver SENDS TELEMETRY BY DEFAULT, and it registers on the first run of ANY
 * subcommand — measured 2026-09-04: after nothing but `doctor`, `telemetry status`
 * read `enabled (source: default)` with a generated installation ID and
 * `Registration recorded: true`. A persistent id had been transmitted.
 *
 * Atlarix's README says "no file contents are sent as telemetry" and sells the app
 * as the Private AI Workstation. Shipping a bundled binary that phones home the
 * first time anyone uses a feature contradicts the central product claim.
 *
 * THE ORDER IS THE WHOLE POINT. The opt-out is a plain file. Writing it BEFORE the
 * first spawn is the only thing that works — running `telemetry disable` afterwards
 * is too late, because that command is itself an invocation and registration has
 * already happened.
 */
function cuaHomeDir(): string {
  return path.join(os.homedir(), ".cua-driver");
}

export function telemetryOptOutPath(): string {
  return path.join(cuaHomeDir(), "config.json");
}

/** True when the opt-out is on disk and actually says false. */
export function telemetryIsOptedOut(): boolean {
  try {
    const raw = JSON.parse(readFileSync(telemetryOptOutPath(), "utf8")) as {
      telemetry_enabled?: boolean;
    };
    return raw.telemetry_enabled === false;
  } catch {
    return false;
  }
}

/**
 * Write the opt-out, preserving anything else already in the file (the driver
 * keeps other settings there too, and clobbering them would be rude).
 */
export function ensureTelemetryOptOut(): void {
  const file = telemetryOptOutPath();
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // No file, or unreadable — either way we are about to write a good one.
  }
  if (existing.telemetry_enabled === false) return;
  mkdirSync(cuaHomeDir(), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...existing, telemetry_enabled: false }, null, 2)}\n`);
  logger.info(`[computer-use] wrote telemetry opt-out to ${file}`);
}

// ── settings + platform gates ────────────────────────────────────────────────

/**
 * `readSettings()` is synchronous and UNCACHED, which is what makes the Settings
 * toggle take effect immediately — so this re-reads per call rather than caching at
 * module scope. (The one place that deliberately snapshots is
 * `PermissionInterceptor`'s `turnWorkMode`, and its comment explains why.)
 *
 * Default ON: the owner's decision is no per-app prompt and the tool available by
 * default, gated only by `.atlarix/permissions.json` — so `!== false`, matching
 * every other default-on gate in this codebase.
 */
export function computerUseEnabled(): boolean {
  try {
    return readSettings().computerUse !== false;
  } catch {
    return true;
  }
}

function macosTooOld(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    // Electron augments `process` with this; it returns the real macOS version
    // ("14.5", "26.0"), which `os.release()` does NOT — that gives the Darwin
    // kernel version, and the Darwin→macOS mapping broke when Apple jumped from
    // 15 to 26. Cast because the augmentation is not in the app-side types.
    const getSystemVersion = (process as NodeJS.Process & {
      getSystemVersion?: () => string;
    }).getSystemVersion;
    if (!getSystemVersion) return null;
    const major = Number(getSystemVersion().split(".")[0]);
    if (Number.isFinite(major) && major < MIN_MACOS_MAJOR) {
      return (
        `Desktop control needs macOS ${MIN_MACOS_MAJOR} or later; this machine runs ` +
        `macOS ${major}. This is a platform limitation, not a transient failure — do not retry.`
      );
    }
  } catch {
    // Outside Electron, or an unparseable version — let the spawn decide.
  }
  return null;
}

// ── the socket, and a limit that really does bite ────────────────────────────

/**
 * `SUN_LEN` IS REAL. A long path fails at bind with
 * `path must be shorter than SUN_LEN` — observed while testing, using a path under
 * a temp dir. macOS caps `sun_path` at 104 bytes.
 *
 * `~/Library/Application Support/Atlarix/cua.sock` is ~55 characters, so userData is
 * fine — but assert it rather than surfacing a bind error, because the bind error
 * arrives from a child process and reads like a driver bug.
 *
 * Windows uses a named pipe keyed by a hash of userData, so a Squirrel install and
 * an MSIX install cannot collide on one machine.
 */
export function socketPath(): string {
  if (process.platform === "win32") {
    let key = "default";
    try {
      key = Buffer.from(app.getPath("userData")).toString("hex").slice(0, 16);
    } catch {
      /* keep the default */
    }
    return `\\\\.\\pipe\\atlarix-cua-${key}`;
  }
  let base: string;
  try {
    base = app.getPath("userData");
  } catch {
    base = os.tmpdir();
  }
  return path.join(base, "cua.sock");
}

const SUN_LEN_MAX = 104;

function assertSocketPathFits(p: string): void {
  if (process.platform === "win32") return;
  const bytes = Buffer.byteLength(p);
  if (bytes >= SUN_LEN_MAX) {
    throw new ComputerUseError(
      "spawn-failed",
      `The computer-use socket path is ${bytes} bytes, over the ${SUN_LEN_MAX}-byte ` +
        `OS limit for a Unix socket (${p}). Desktop control cannot start. Tell the user; ` +
        `do not retry.`,
    );
  }
}

// ── invoking the driver ──────────────────────────────────────────────────────

function run(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || "").trim() || err.message;
          resolve({ ok: false, error: detail });
          return;
        }
        resolve({ ok: true, stdout: String(stdout) });
      },
    );
  });
}

async function daemonRunning(bin: string): Promise<boolean> {
  const r = await run(bin, ["status", "--socket", socketPath()], 8_000);
  return r.ok && /is running/i.test(r.stdout);
}

/**
 * REMOVE A STALE SOCKET BEFORE SPAWNING, because an unclean exit leaves one and it
 * breaks the feature permanently until the file is deleted.
 *
 * Observed on a packaged build 2026-09-05: the app was force-killed, so the daemon
 * never unlinked its endpoint, and every later start failed with
 *
 *     cua-driver serve error: embedded daemon endpoint already exists at
 *     …/cua.sock; the owning host must prove and remove its stale socket
 *     before spawn
 *
 * The teardown in `stopComputerUse` does `stop --socket` and then kills, which
 * handles a clean quit. It cannot handle a SIGKILL, a crash, or a power loss — and
 * after any of those, computer use was dead for good with an error naming a 20s
 * readiness timeout rather than a leftover file.
 *
 * The driver states the protocol in that message: the host must PROVE the socket is
 * stale and then remove it. `status --socket` is the proof — it reports
 * "Cua Driver daemon is not running" for an orphaned endpoint. So: no file, nothing
 * to do; file plus a live daemon, reuse it and never unlink (that would be another
 * Atlarix instance's endpoint); file with no live daemon, unlink and continue.
 *
 * Unlinking is deliberately NOT unconditional. A blind `rm` would let a second
 * instance steal a running instance's socket, and the failure that produces is far
 * worse than this one: two hosts driving one desk.
 */
export async function clearStaleSocket(bin: string, sock: string): Promise<void> {
  if (process.platform === "win32") return; // named pipe; no file to leak
  if (!existsSync(sock)) return;

  if (await daemonRunning(bin)) {
    // Someone is home. Not ours to delete.
    logger.info("[computer-use] a daemon is already listening on the socket; reusing it");
    return;
  }

  try {
    unlinkSync(sock);
    logger.warn(
      `[computer-use] removed a stale daemon socket at ${sock} — the previous ` +
        `daemon exited without cleaning up (a force-kill or crash does that)`,
    );
  } catch (e) {
    // Surface it rather than letting `serve` fail with its own less specific
    // message: a socket we cannot remove is a permissions or ownership problem
    // the user can act on.
    throw new ComputerUseError(
      "stale-socket",
      `A stale desktop-control socket at ${sock} could not be removed ` +
        `(${(e as Error).message}). Ask the user to delete that file and retry ONCE ` +
        `after they confirm — do not retry before then.`,
    );
  }
}

async function spawnDaemon(bin: string): Promise<void> {
  const sock = socketPath();
  assertSocketPathFits(sock);
  await clearStaleSocket(bin, sock);

  // `--embedded` is the flag that keeps TCC attribution on Atlarix and stops the
  // driver ever raising its own permission prompt. Without it, `serve` would
  // relaunch itself as CuaDriver.app and the user would be asked to grant
  // Accessibility to a stranger.
  const args = ["serve", "--embedded", "--socket", sock];

  const proc = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    // NOT detached: we want it in our process group so a crash of the app takes
    // the daemon with it rather than orphaning a process holding Accessibility.
    detached: false,
  });
  child = proc;
  ready = false;

  proc.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) logger.warn(`[computer-use] daemon: ${line.slice(0, 400)}`);
  });
  proc.on("exit", (code, signal) => {
    // Clearing the handle is what allows the single per-session respawn below.
    if (child === proc) {
      child = null;
      ready = false;
    }
    logger.warn(`[computer-use] daemon exited (code=${code} signal=${signal ?? "none"})`);
  });
  proc.on("error", (e) => {
    logger.warn(`[computer-use] daemon spawn error: ${e.message}`);
  });

  const started = Date.now();
  while (Date.now() - started < READY_TIMEOUT_MS) {
    if (child !== proc) break; // it exited while we waited
    if (await daemonRunning(bin)) {
      ready = true;
      const version = await run(bin, ["--version"], 8_000);
      logger.info(
        `[computer-use] daemon ready in ${Date.now() - started}ms — ` +
          `${version.ok ? version.stdout.trim() : "version unknown"}, socket ${sock}`,
      );
      return;
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }

  try {
    proc.kill();
  } catch {
    /* already gone */
  }
  throw new ComputerUseError(
    "not-ready",
    `The desktop-control helper did not become ready within ${READY_TIMEOUT_MS / 1000}s. ` +
      `Tell the user and do not retry this call.`,
  );
}

/**
 * Start the daemon if it is not already up.
 *
 * LAZILY, ON FIRST USE — never at app start. Two reasons: it adds a Rust process
 * and its capture initialisation to every launch for users who never touch the
 * feature, and on macOS a spawn can provoke a TCC prompt at a moment when the user
 * has no idea why they are being asked.
 *
 * ONE RESPAWN PER SESSION. We retry the DAEMON, never the ACTION — the existing
 * doctrine from `windowsSandboxUsable`, which deliberately never re-probes after a
 * user command fails. If the daemon dies mid-action the caller must tell the model
 * the effect is UNKNOWN rather than that it failed, because a click may well have
 * landed.
 */
export async function ensureDaemon(): Promise<string> {
  if (!computerUseEnabled()) {
    throw new ComputerUseError(
      "disabled-by-setting",
      "Desktop control is switched off for this install (Settings → Computer use). " +
        "Ask the user to enable it; do not retry before they confirm.",
    );
  }
  const tooOld = macosTooOld();
  if (tooOld) throw new ComputerUseError("unsupported-os-version", tooOld);

  const bin = resolveComputerBinary("cua-driver");
  if (!bin) throw new ComputerUseError("not-installed", missingBinaryMessage("cua-driver"));

  if (child && ready) return bin;

  // Concurrent first calls (five sub-agents starting at once) must not race into
  // five daemons.
  if (starting) {
    await starting;
    return bin;
  }

  starting = (async () => {
    // STEP ONE, BEFORE ANY INVOCATION. See `ensureTelemetryOptOut`.
    ensureTelemetryOptOut();
    // An already-running daemon (another window, or a `serve` the user started)
    // does not consume the start budget — we did not spawn it.
    if (await daemonRunning(bin)) {
      ready = true;
      return;
    }
    if (startCount >= MAX_STARTS) {
      throw new ComputerUseError(
        "killed",
        "The desktop-control helper has stopped and already been restarted once this " +
          "session. Not restarting again — something is wrong with it rather than with " +
          "this call. Tell the user to restart Atlarix; do not retry.",
      );
    }
    startCount++;
    await spawnDaemon(bin);
  })();

  try {
    await starting;
  } finally {
    starting = null;
  }
  return bin;
}

/** Tests only: burn the start budget, to exercise the refuse-after-one-respawn path. */
export function exhaustStartBudgetForTests(): void {
  startCount = MAX_STARTS;
}

/**
 * One tool call through the daemon.
 *
 * `--screenshot-out-file` is how image content stays OUT of this process: the
 * driver writes a PNG to a path we choose and we hand that path to the OCR helper,
 * so nothing round-trips through base64 or through the model's context.
 */
export async function callDriver(
  tool: string,
  input: Record<string, unknown> = {},
  opts?: { screenshotOutFile?: string; timeoutMs?: number },
): Promise<unknown> {
  const bin = await ensureDaemon();
  const args = ["call", tool, JSON.stringify(input), "--socket", socketPath()];
  if (opts?.screenshotOutFile) args.push("--screenshot-out-file", opts.screenshotOutFile);

  const r = await run(bin, args, opts?.timeoutMs ?? CALL_TIMEOUT_MS);
  if (!r.ok) {
    throw new ComputerUseError("spawn-failed", `cua-driver ${tool}: ${r.error}`);
  }
  const text = r.stdout.trim();
  if (!text) return {};
  // The driver prints a human banner before JSON in some modes (the telemetry
  // notice was one, which the opt-out removes) — find the document rather than
  // trusting the first byte. Same lesson as `uiautomator dump`: parse the SHAPE.
  const start = text.search(/[[{]/);
  if (start < 0) return { raw: text };
  try {
    return JSON.parse(text.slice(start)) as unknown;
  } catch {
    return { raw: text };
  }
}

/**
 * Stop the daemon. Called from the `before-quit` chain.
 *
 * `stop --socket` first for a clean shutdown (it releases the socket and tears down
 * the session cursor), then kill what is left. Never throws — quit must not hang on
 * a helper that is already gone, which is the common case.
 */
export async function stopComputerUse(): Promise<void> {
  const proc = child;
  child = null;
  ready = false;
  const bin = resolveComputerBinary("cua-driver");
  if (bin) {
    try {
      await run(bin, ["stop", "--socket", socketPath()], 5_000);
    } catch {
      /* it may already be down; the kill below is the backstop */
    }
  }
  if (!proc || proc.exitCode !== null) return;
  try {
    proc.kill();
  } catch {
    /* gone */
  }
}

/** Tests only. */
export function resetDriverSessionForTests(): void {
  child = null;
  ready = false;
  startCount = 0;
  starting = null;
}

export function driverSessionStateForTests(): {
  hasChild: boolean;
  ready: boolean;
  startCount: number;
} {
  return { hasChild: child !== null, ready, startCount };
}

/** Present so a caller can check without paying for a spawn. */
export function driverBinaryExists(): boolean {
  return existsSync(String(resolveComputerBinary("cua-driver") ?? ""));
}
