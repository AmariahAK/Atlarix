/**
 * Which mechanism delivers input, and what to refuse when the good ones are gone.
 *
 * | rung | mechanism | background? | when |
 * |---|---|---|---|
 * | 1 | cua-driver AX path (`AXUIElementPerformAction`) | yes — posts no events at all | ALWAYS preferred |
 * | 2 | cua-driver pixel path (`SLPSPostEventRecordTo`, private SkyLight) | yes | probe green |
 * | 3 | `atlarix-cu post` (`CGEventPostToPid`, public since 10.11) | keyboard yes; mouse unreliable | probe red |
 * | 4 | structured refusal | — | probe red AND the action needs a pixel |
 *
 * Rung 1 is not a fallback, it is the default: acting through the accessibility
 * API posts no events whatsoever, so it survives ANY change Apple makes to the
 * private symbol. Rungs 2–4 only matter for the minority of actions that cannot be
 * expressed as an AX action.
 *
 * ROUTING, NOT PATCHING. cua-driver stays unmodified — a fork would have to be
 * re-merged on every pin bump — so when the private symbol disappears we send the
 * input somewhere else rather than changing how the driver sends it.
 *
 * WHY RUNG 3 IS NOT A BLANKET REPLACEMENT, which is the whole reason rung 4 exists:
 * `CGEventPostToPid` delivers KEYBOARD events to a background process reliably (the
 * event reaches the process, and the focused view handles it), but a MOUSE event
 * carries a screen location that a well-behaved app hit-tests against its own
 * window. Post a click at coordinates the target does not own — or while another
 * window is above it — and it may be ignored, or handled somewhere else entirely.
 * `anthropics/mac-cua` takes this route and lives with the same caveat. A wrong
 * click inside someone's application is worse than a refusal: a refusal costs a
 * turn, a misplaced click can send a message or accept a dialog.
 */
import { execFile } from "node:child_process";
import log from "electron-log";
import { resolveComputerBinary } from "./resolve-binary";

const logger = log.scope("computer-use");

/**
 * WHAT THE PROBE CAN REPORT. Rungs 1-3 only — see `pixelDeliveryRefused` for 4.
 *
 * `"refuse"` used to be a member of this union and NOTHING EVER PRODUCED IT.
 * `probe.rs` emits only `driver-spi` or `public-fallback`, and every non-probe exit
 * below returns `driver-spi`, so both `rung === "refuse"` call sites were dead and
 * `refusePixelAction` was dead code — the table above described a control that did
 * not exist. Exactly the failure the header's own `windowsSandboxUsable` citation
 * warns about, and the same dead-branch shape as `ax-tree.ts`'s `degraded` flag.
 *
 * Rung 4 is a DECISION taken from rung 3, not something a probe can find, because it
 * depends on what the action needs: the same red probe is fine for a keystroke and
 * not fine for a mouse event.
 */
export type InputRung = "driver-ax" | "driver-spi" | "public-fallback";

interface ProbeReport {
  ok?: boolean;
  skylight_loaded?: boolean;
  symbols?: Record<string, boolean>;
  rung?: string;
}

/** Probed once per session. The answer cannot change while we run. */
let cached: InputRung | null = null;

function runHelper(args: string[], timeoutMs = 10_000): Promise<string | null> {
  const bin = resolveComputerBinary("atlarix-cu");
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

/**
 * Which pixel-input rung is available.
 *
 * Symbol presence only, and side-effect free — `dlopen` + `dlsym` costs
 * microseconds and catches the likely break (a removed or renamed symbol). What it
 * cannot distinguish is "present" from "present but now a no-op or newly gated";
 * that needs a real event, and the only genuinely inert one is a ZERO-DELTA SCROLL
 * posted to our own pid. That behavioural half is deliberately not here: it needs a
 * window and a renderer listener, **it cannot run in CI**, and pretending otherwise
 * would let a green badge imply that input works.
 */
export async function detectInputRung(): Promise<InputRung> {
  if (cached) return cached;
  if (process.platform !== "darwin") {
    // Windows and Linux never used the SkyLight SPI; the driver owns input there
    // directly and there is no fallback to choose.
    cached = "driver-spi";
    return cached;
  }
  const out = await runHelper(["probe", "--json"]);
  if (!out) {
    // No helper — we cannot know, so assume the driver's own path and let it fail
    // with its own message rather than pre-emptively refusing.
    logger.warn("[computer-use] atlarix-cu probe unavailable; assuming the driver's SPI path");
    cached = "driver-spi";
    return cached;
  }
  let report: ProbeReport = {};
  try {
    report = JSON.parse(out.slice(Math.max(0, out.search(/[{[]/)))) as ProbeReport;
  } catch {
    cached = "driver-spi";
    return cached;
  }
  cached = report.rung === "public-fallback" ? "public-fallback" : "driver-spi";
  // Logged at info with the rung NAMED, per the `windowsSandboxUsable` doctrine: a
  // control that degrades silently must be observable, which is how a broken
  // Windows sandbox went unnoticed for releases.
  logger.info(
    `[computer-use] input rung: ${cached} (skylight=${report.skylight_loaded ?? "?"}, ` +
      `symbols=${JSON.stringify(report.symbols ?? {})})`,
  );
  return cached;
}

export function resetInputRungForTests(): void {
  cached = null;
}

/**
 * Post a key through the public fallback. Keyboard only — see the header.
 */
export async function postKeyViaFallback(pid: number, key: string): Promise<void> {
  const out = await runHelper(["post", "key", "--pid", String(pid), "--key", key]);
  if (out === null) {
    throw new Error(
      "The public input fallback is unavailable, and the driver's own input path is " +
        "not working on this machine. Tell the user; do not retry.",
    );
  }
}

/** Post a scroll through the public fallback. */
export async function postScrollViaFallback(
  pid: number,
  dx: number,
  dy: number,
): Promise<void> {
  const out = await runHelper([
    "post", "scroll", "--pid", String(pid), "--dx", String(dx), "--dy", String(dy),
  ]);
  if (out === null) {
    throw new Error(
      "The public input fallback is unavailable, and the driver's own input path is " +
        "not working on this machine. Tell the user; do not retry.",
    );
  }
}

/**
 * RUNG 4, as a decision rather than a probe result.
 *
 * The header's argument, restated because this is the line that enforces it:
 * `CGEventPostToPid` delivers a KEYBOARD event to a background process reliably,
 * and a MOUSE event carries a screen location the target hit-tests against its own
 * window — so on rung 3 a keystroke lands and a click may be ignored, or handled
 * somewhere else entirely. A wrong click is worse than a refusal: a refusal costs a
 * turn, a misplaced click can send a message or accept a dialog.
 *
 * So: coordinate-addressed actions are refused once the SPI path is gone. Actions
 * addressed by an element `ref` are untouched — they use the accessibility path and
 * post no events at all, which is rung 1 and why it is the default.
 */
export function pixelDeliveryRefused(rung: InputRung): boolean {
  return rung === "public-fallback";
}

/**
 * The message a model gets when a pixel action cannot be delivered.
 *
 * Category 3 wording (refused by policy, permanent) with an alternative, so the
 * model switches strategy instead of probing for a spelling that works.
 */
export function refusePixelAction(action: string): string {
  return (
    `Pixel ${action} is not available on this machine: the background input path is ` +
    `missing, and the public fallback cannot place a mouse event reliably inside another ` +
    `app's window — it would click the wrong thing rather than fail. Atlarix will not do ` +
    `this. Do not retry — re-read the window and act on an element \`ref\`, which uses the ` +
    `accessibility path and needs no coordinates.`
  );
}
