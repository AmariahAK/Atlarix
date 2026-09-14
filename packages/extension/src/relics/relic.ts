/**
 * The viewer: fetch a relic, hand it to the sandbox, never look at it.
 *
 * This page has `chrome.storage` and therefore must not run the relic. The
 * frame runs the relic and therefore must not have `chrome.storage`. Everything
 * below is in service of keeping those two facts apart.
 */

import { getRelic, type Relic } from "./store";

const stage = document.getElementById("stage") as HTMLIFrameElement | null;
const titleEl = document.getElementById("title");
const notice = document.getElementById("notice");
const save = document.getElementById("save") as HTMLButtonElement | null;

/** A problem worth showing that does not mean the page is over. */
function warn(message: string): void {
  if (!notice) return;
  // First one only. A relic pulling in six scripts would otherwise stack six
  // near-identical paragraphs above the frame.
  if (!notice.hidden) return;
  notice.textContent = message;
  notice.hidden = false;
  notice.classList.add("notice--warn");
}

function fail(message: string): void {
  if (notice) {
    notice.textContent = message;
    notice.hidden = false;
  }
  stage?.remove();
  if (save) save.hidden = true;
}

/**
 * The relic, in flight.
 *
 * WHY THIS PUSHES INSTEAD OF WAITING, and it is the second version of this
 * code. The first waited for the sandbox to announce itself, then also for the
 * frame's `load` event as a backstop — two triggers, both EVENTS. This file is
 * a module script, which is deferred: it evaluates after the document has been
 * parsed. `sandbox.html` and `sandbox.js` are tiny local files, so by the time
 * this runs BOTH of those events have frequently already fired, and neither
 * listener was attached to hear them. The relic was never sent, the frame sat
 * on its empty shell, and there was nothing in the console because nothing had
 * failed — a message was simply spoken to an empty room.
 *
 * Measured in the loaded extension: `document.body.innerHTML.length` in the
 * frame was 44 — the bootstrap script tag and nothing else.
 *
 * So the parent now SENDS as soon as it has something to send, and keeps
 * sending until the sandbox says it rendered. A retry cannot miss a moment that
 * has already passed, which is the property the event listeners lacked.
 */
const params = new URLSearchParams(location.search);
const sessionId = params.get("session") ?? "";
const relicId = params.get("id") ?? "";
const pending: Promise<Relic | null> =
  sessionId && relicId ? getRelic(sessionId, relicId) : Promise.resolve(null);

/** How often to re-offer the relic, and for how long before admitting defeat. */
const RETRY_MS = 100;
const GIVE_UP_MS = 5_000;

/** Set when the sandbox confirms it rendered. Until then, keep offering. */
let shown = false;
let retrying: ReturnType<typeof setInterval> | undefined;
let started = false;

async function hand(): Promise<void> {
  if (started) return;
  started = true;
  const relic = await pending;
  if (!relic) return;

  const offer = () => {
    stage?.contentWindow?.postMessage(
      { kind: "atlarix:relic", html: relic.html },
      "*",
    );
  };

  offer();
  retrying = setInterval(() => {
    if (shown) {
      clearInterval(retrying);
      return;
    }
    offer();
  }, RETRY_MS);

  // A DEAD FRAME MUST SAY SO. Silence here was the whole failure: a blank white
  // rectangle is indistinguishable from a feature that does not work, and it
  // left nothing for anyone to go on.
  setTimeout(() => {
    if (shown) return;
    clearInterval(retrying);
    warn(
      "This relic could not be displayed — the viewer never got an answer " +
        "from its sandbox. Reopening the tab usually fixes it.",
    );
  }, GIVE_UP_MS);
}

window.addEventListener("message", (event: MessageEvent) => {
  // NO SOURCE CHECK, AND THAT IS DELIBERATE — it was here and it may be why
  // nothing rendered.
  //
  // `event.origin` proves nothing: the frame has an opaque origin, so it is the
  // string "null", which any sandboxed frame produces. Window IDENTITY looked
  // like the rigorous alternative, and in a real extension a manifest-sandboxed
  // frame's `event.source` is not reliably the same object as
  // `iframe.contentWindow`. When it does not match, every message is silently
  // dropped and the page sits blank with nothing in the console.
  //
  // Dropping the check costs nothing, because NOTHING RECEIVED HERE BECOMES
  // CONTENT. This page only ever SENDS the relic; the inbound messages set a
  // boolean and show a warning string we wrote ourselves. A hostile message can
  // stop a retry loop or display one of our own sentences — it cannot put
  // anything on screen, reach storage, or change what the sandbox is given.
  const data = event.data as { kind?: string } | null;
  if (!data || typeof data.kind !== "string") return;
  if (!data.kind.startsWith("atlarix:relic")) return;
  // Still honoured as the FAST path — when the sandbox does get in first, this
  // saves a retry tick. It is no longer load-bearing.
  if (data.kind === "atlarix:relic-ready") void hand();
  if (data.kind === "atlarix:relic-shown") {
    shown = true;
    if (retrying) clearInterval(retrying);
  }

  // THE RELIC TOLD US IT WAS REFUSED SOMETHING. Shown rather than swallowed: a
  // relic whose interface was built by a blocked script is a white rectangle,
  // and a white rectangle with no explanation is the worst possible failure —
  // indistinguishable from the feature simply not working.
  if (data.kind === "atlarix:relic-blocked") {
    const blocked = data as { uri?: unknown; directive?: unknown };
    const uri = typeof blocked.uri === "string" ? blocked.uri : "";
    const directive =
      typeof blocked.directive === "string" ? blocked.directive : "";
    warn(
      `This relic tried to load ${uri || "something"} (${directive || "blocked"}). ` +
        `Relics run with no network, so anything they need has to be written ` +
        `into the file. Ask Atlarix to rebuild it with the code inline.`,
    );
  }
});

// Kept as another fast path, not as a safety net — see `hand`.
stage?.addEventListener("load", () => void hand());

async function main(): Promise<void> {
  if (!sessionId || !relicId) {
    fail("This link is incomplete — no relic to show.");
    return;
  }

  const relic = await pending;
  if (!relic) {
    // The honest cause: relics live with their conversation, so deleting the
    // conversation takes them. Saying "not found" would send someone looking
    // for a bug.
    fail(
      "That relic is gone. Relics are kept with the conversation that made " +
        "them, so deleting the conversation deletes them too.",
    );
    return;
  }

  document.title = `${relic.title} · Atlarix`;
  if (titleEl) titleEl.textContent = relic.title;

  // DOWNLOAD FROM A BLOB WE BUILD HERE, not a link the relic could rewrite.
  // Saving is the one thing that crosses back out of the sandbox, so the bytes
  // come from storage rather than from anything the frame says.
  save?.addEventListener("click", () => {
    const blob = new Blob([relic.html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${relic.title.replace(/[^\w.-]+/g, "-").slice(0, 60) || "relic"}.html`;
    link.click();
    URL.revokeObjectURL(url);
  });

  // In case both triggers already fired while the record was being read.
  void hand();
}

void main().catch(() => {
  fail("This relic could not be opened.");
});
