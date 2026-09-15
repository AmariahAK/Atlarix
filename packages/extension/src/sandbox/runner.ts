/**
 * The sandboxed page that owns the worker — and the only thing that can kill it.
 *
 * Declared under the manifest's `sandbox.pages`, so Chrome loads it into an
 * OPAQUE ORIGIN: no `chrome.*`, no same-origin handle back to the extension, no
 * session, no site grants, and — because the sandbox CSP says `connect-src
 * 'none'` — no network. It is the relic sandbox's sibling, and for the same
 * reason: the code it runs was written by a model whose input includes web
 * pages, so it is untrusted in the strongest sense.
 *
 * ══ WHAT THIS FILE IS ACTUALLY FOR ══
 *
 * Not isolation — the manifest does that. This exists to hold the TIMEOUT.
 *
 * The worker is created here rather than in the panel because a blob worker
 * inherits the origin and CSP of whoever created it. Created in the panel it
 * would be an extension-origin worker, which is precisely the thing model code
 * must never be. Created here it inherits an opaque origin and a policy with no
 * network, which is the whole security argument in one line.
 *
 * And because it is created here, `terminate()` can be called here — by a timer
 * on THIS page's thread, which keeps running no matter what the worker does.
 * A timer in the panel would be the backstop for a hung frame; a timer here is
 * the backstop for a hung run, and the two are different failures.
 *
 * ══ IDEMPOTENT BY REQUEST ID ══
 *
 * The relic viewer re-offers its payload every 100 ms until the sandbox
 * acknowledges it, because a message spoken to an empty room is lost forever.
 * That pattern is exactly wrong here: re-offering a RUN runs it twice, so the
 * user gets two files and any arithmetic happens twice — and it is
 * timing-dependent, so it would pass every local test and fail on a loaded
 * machine.
 *
 * Two defences, because one of them is a design and the other is a fact of
 * life. The panel does not retry at all (it attaches its listener before the
 * frame exists, so it cannot miss the ready message). And every request carries
 * an id: a repeat of an id already running is IGNORED, and a repeat of one
 * already finished is answered from the recorded result rather than re-run.
 */

import type { SandboxLimits, WorkerResult } from "./worker";

/** What the panel sends. `prelude` is the worker's source, fetched by the panel. */
interface RunRequest {
  kind: "atlarix:run";
  id: string;
  prelude: string;
  code: string;
  inputs: unknown[];
  limits: SandboxLimits;
  timeoutMs: number;
}

type Answer = Omit<WorkerResult, "kind">;

/**
 * How many finished runs are remembered for the idempotency check.
 *
 * Small on purpose: this is a defence against a duplicate arriving moments
 * after the first, not a result cache. Holding every run's files would keep the
 * bytes of a whole conversation alive in a frame nobody can see.
 */
const REMEMBER = 8;

const finished = new Map<string, Answer>();
const running = new Set<string>();

function reply(id: string, answer: Answer): void {
  // `*` is the only target available: this page has an opaque origin, so there
  // is no origin string the parent could match on either side. Nothing received
  // here becomes a capability — the worst a forged message can do is run code
  // in a sandbox that can reach nothing and send the answer to the panel, which
  // ignores ids it did not issue.
  parent.postMessage({ kind: "atlarix:run-result", id, ...answer }, "*");
}

function remember(id: string, answer: Answer): void {
  finished.set(id, answer);
  running.delete(id);
  while (finished.size > REMEMBER) {
    const oldest = finished.keys().next();
    if (oldest.done) break;
    finished.delete(oldest.value);
  }
}

function start(request: RunRequest): void {
  const { id } = request;

  const already = finished.get(id);
  if (already) {
    reply(id, already);
    return;
  }
  // In flight. Answering now would be answering with nothing; the real result
  // is already on its way to the same listener.
  if (running.has(id)) return;
  running.add(id);

  let worker: Worker;
  let url: string;
  try {
    url = URL.createObjectURL(
      new Blob([request.prelude], { type: "text/javascript" }),
    );
    worker = new Worker(url);
  } catch (err) {
    remember(id, {
      ok: false,
      stdout: "",
      truncated: false,
      error: `The sandbox could not start: ${err instanceof Error ? err.message : String(err)}`,
      value: null,
      files: [],
    });
    reply(id, finished.get(id) as Answer);
    return;
  }

  let settled = false;
  const settle = (answer: Answer): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    worker.terminate();
    // Revoked on the way out. A blob URL that is never revoked keeps its bytes
    // alive for the life of the page, and this page lives as long as the panel.
    URL.revokeObjectURL(url);
    remember(id, answer);
    reply(id, answer);
  };

  const timer = setTimeout(() => {
    settle({
      ok: false,
      stdout: "",
      truncated: false,
      error:
        `Your code ran for ${Math.round(request.timeoutMs / 1000)} seconds without ` +
        `finishing and was stopped. Nothing it produced was kept. Look for a ` +
        `loop that never ends or an await on something that never settles — ` +
        `there is no network here, so anything waiting on one will wait forever.`,
      value: null,
      files: [],
    });
  }, request.timeoutMs);

  worker.onmessage = (event: MessageEvent) => {
    const message = event.data as WorkerResult | null;
    if (!message || message.kind !== "atlarix:worker-done") return;
    const { kind: _kind, ...answer } = message;
    settle(answer);
  };

  // A worker that fails to LOAD reports here with an empty message, which is
  // what `worker-src` blocking a blob looks like. Said plainly, because the
  // symptom on its own is indistinguishable from the feature not existing.
  worker.onerror = (event: ErrorEvent) => {
    settle({
      ok: false,
      stdout: "",
      truncated: false,
      error:
        event.message ||
        "The sandbox worker would not start. This build's sandbox policy is " +
          "missing `worker-src blob:`, which Chrome reports as a bare error " +
          "with no message.",
      value: null,
      files: [],
    });
  };

  worker.postMessage({
    kind: "atlarix:worker-run",
    code: request.code,
    inputs: request.inputs,
    limits: request.limits,
  });
}

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as RunRequest | null;
  if (!data || data.kind !== "atlarix:run" || typeof data.id !== "string") {
    return;
  }
  start(data);
});

// Said once, and never repeated. The panel attaches its listener before this
// frame is created, so it cannot miss this — which is what lets the whole
// protocol avoid the retry loop the relic viewer needs.
parent.postMessage({ kind: "atlarix:runner-ready" }, "*");
