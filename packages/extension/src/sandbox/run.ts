/**
 * The panel's half of the code sandbox: mount the frame, ask once, wait.
 *
 * ══ WHY THE PANEL AND NOT THE SERVICE WORKER ══
 *
 * Same answer as `agent/loop.ts` gives for the agent loop, and for a sharper
 * reason. A run can take fifteen seconds; the service worker is evicted after
 * thirty of idleness and has no DOM to host a frame in at all. The panel is
 * where the loop already lives, so the run is a call inside a turn rather than
 * a message across a process boundary that may not exist.
 *
 * The cost is stated plainly rather than hidden: the files live in this
 * document's memory, so CLOSING THE PANEL LOSES ANY THE USER HAS NOT SAVED.
 * That is the literal reading of the instruction this feature was built to —
 * "does not affect the storage and does not get saved beyond the session" — and
 * it is why `files/store.ts` is a `Map` and not `chrome.storage`.
 *
 * ══ NO RETRY LOOP, AND THAT IS THE WHOLE PROTOCOL DESIGN ══
 *
 * `relics/relic.ts` re-offers its payload every 100 ms until the sandbox
 * acknowledges, because its listener was attached too late to hear the frame
 * announce itself and a missed event is missed forever. Copying that here would
 * be a defect rather than a pattern: re-offering a RUN runs it twice, so the
 * user gets two files and any arithmetic happens twice — timing-dependent,
 * therefore green locally and wrong on a loaded machine.
 *
 * The fix is ordering, not retries. The `message` listener is attached BEFORE
 * the iframe element exists, so there is no moment in which the ready message
 * could be spoken to an empty room. `runner.ts` is idempotent by request id as
 * well, because two independent reasons to be correct is the right number for
 * something whose failure is invisible.
 */

import { api } from "../shared/browser-api";
import {
  DEFAULT_LIMITS,
  type SandboxFile,
  type SandboxInput,
  type SandboxLimits,
  type WorkerResult,
} from "./worker";

export type RunOutcome = Omit<WorkerResult, "kind">;

/**
 * How long the model's code may run before it is terminated.
 *
 * Generous, because the work is real: deflating a large workbook or rasterising
 * a chart is seconds of honest computation, and a limit that kills those would
 * make the tool feel broken rather than bounded. It is affordable precisely
 * because the run is on a worker thread — the panel stays responsive throughout,
 * so the only thing a long run costs is the user's patience.
 */
export const RUN_TIMEOUT_MS = 15_000;

/** How long to wait for the sandbox page itself to load before giving up. */
const MOUNT_TIMEOUT_MS = 5_000;

/**
 * The panel's own backstop, on top of the runner's.
 *
 * They guard different failures. The runner's timer kills a hung RUN; this one
 * catches a hung FRAME — one that never answers at all, because it crashed, was
 * torn out of the document, or was never really there. Without it a broken
 * frame hangs the turn rather than failing it.
 */
const BACKSTOP_SLACK_MS = 3_000;

let frame: HTMLIFrameElement | null = null;
let mounted: Promise<HTMLIFrameElement> | null = null;
let prelude: Promise<string> | null = null;

/**
 * Drop the frame so the next run builds a fresh one.
 *
 * Called when a run goes unanswered, which is the only evidence available that
 * the frame is gone: an iframe that has crashed is still an element, still has
 * a `contentWindow`, and still accepts `postMessage` without complaint.
 */
export function resetSandbox(): void {
  frame?.remove();
  frame = null;
  mounted = null;
}

/** The worker's source, read from our own package. Fetched once per panel. */
function workerSource(): Promise<string> {
  prelude ??= fetch(api().runtime.getURL("runner-worker.js")).then((res) =>
    res.text(),
  );
  return prelude;
}

function mount(): Promise<HTMLIFrameElement> {
  if (mounted) return mounted;

  mounted = new Promise<HTMLIFrameElement>((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { kind?: string } | null;
      if (data?.kind !== "atlarix:runner-ready") return;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(el);
    };
    // ATTACHED BEFORE THE ELEMENT EXISTS. This ordering is what makes the
    // retry loop unnecessary — see the file docblock.
    window.addEventListener("message", onMessage);

    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resetSandbox();
      reject(
        new Error(
          "The code sandbox did not load. Reopening the panel usually fixes it.",
        ),
      );
    }, MOUNT_TIMEOUT_MS);

    const el = document.createElement("iframe");
    // NO `sandbox` ATTRIBUTE. The manifest's `sandbox.pages` already puts this
    // page in an opaque origin; adding the attribute as well would be a second,
    // quieter policy that has to be kept in step with the first.
    el.setAttribute("aria-hidden", "true");
    el.title = "Atlarix code sandbox";
    el.style.cssText =
      "position:absolute;width:0;height:0;border:0;left:-9999px;top:0";
    el.src = api().runtime.getURL("runner.html");
    document.body.appendChild(el);
    frame = el;
  });

  return mounted;
}

/**
 * Run the model's code and collect whatever it made.
 *
 * NEVER THROWS for anything the model could act on — a syntax error, a timeout
 * and a dead frame all come back as an outcome with `ok: false` and a sentence
 * saying what to do. The one thing that does reject is a sandbox that will not
 * mount at all, because that is a fault in Atlarix rather than in the code.
 */
export async function runInSandbox(request: {
  code: string;
  inputs?: SandboxInput[];
  timeoutMs?: number;
  limits?: SandboxLimits;
}): Promise<RunOutcome> {
  const timeoutMs = request.timeoutMs ?? RUN_TIMEOUT_MS;
  const [el, source] = await Promise.all([mount(), workerSource()]);
  const id = crypto.randomUUID();

  return new Promise<RunOutcome>((resolve) => {
    const settle = (outcome: RunOutcome) => {
      window.removeEventListener("message", onMessage);
      clearTimeout(backstop);
      resolve(outcome);
    };

    const onMessage = (event: MessageEvent) => {
      const data = event.data as ({ kind?: string; id?: string } & RunOutcome) | null;
      // The id check is not a security boundary — nothing here becomes a
      // capability. It is what keeps two runs in the same panel from reading
      // each other's answers.
      if (data?.kind !== "atlarix:run-result" || data.id !== id) return;
      const { ...outcome } = data;
      settle({
        ok: Boolean(outcome.ok),
        stdout: typeof outcome.stdout === "string" ? outcome.stdout : "",
        truncated: Boolean(outcome.truncated),
        error: typeof outcome.error === "string" ? outcome.error : null,
        value: typeof outcome.value === "string" ? outcome.value : null,
        files: Array.isArray(outcome.files) ? (outcome.files as SandboxFile[]) : [],
      });
    };
    window.addEventListener("message", onMessage);

    const backstop = setTimeout(() => {
      // The frame owes us an answer and did not give one, so it is not a frame
      // any more. Torn down rather than reused: whatever state it is in, the
      // next run should not inherit it.
      resetSandbox();
      settle({
        ok: false,
        stdout: "",
        truncated: false,
        error:
          "The code sandbox stopped responding and was restarted. Nothing was " +
          "kept. Try the same code again — if it fails a second time, it is " +
          "asking for something the sandbox cannot do.",
        value: null,
        files: [],
      });
    }, timeoutMs + BACKSTOP_SLACK_MS);

    el.contentWindow?.postMessage(
      {
        kind: "atlarix:run",
        id,
        prelude: source,
        code: request.code,
        inputs: request.inputs ?? [],
        limits: request.limits ?? DEFAULT_LIMITS,
        timeoutMs,
      },
      "*",
    );
  });
}
