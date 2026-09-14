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
 * THE LISTENER IS REGISTERED BEFORE THIS RESOLVES, and that ordering is the
 * bug this shape exists to prevent. The sandbox announces itself the moment it
 * loads; a listener attached after `await getRelic(...)` can miss that message
 * entirely, and the failure is a permanently blank frame with nothing in the
 * console — the frame is fine, it simply said hello to nobody.
 */
const params = new URLSearchParams(location.search);
const sessionId = params.get("session") ?? "";
const relicId = params.get("id") ?? "";
const pending: Promise<Relic | null> =
  sessionId && relicId ? getRelic(sessionId, relicId) : Promise.resolve(null);

/** Sent once. Either trigger may fire first, and only the first one counts. */
let handed = false;
async function hand(): Promise<void> {
  if (handed) return;
  const relic = await pending;
  if (!relic || handed) return;
  handed = true;
  stage?.contentWindow?.postMessage(
    { kind: "atlarix:relic", html: relic.html },
    "*",
  );
}

window.addEventListener("message", (event: MessageEvent) => {
  // THE ONLY CHECK THAT MEANS ANYTHING HERE. The frame has an opaque origin, so
  // `event.origin` is the string "null" and comparing it proves nothing — any
  // sandboxed frame produces it. Identity of the source window is what
  // distinguishes our frame from anything else that can reach this page.
  if (event.source !== stage?.contentWindow) return;
  const data = event.data as { kind?: unknown } | null;
  if (data && data.kind === "atlarix:relic-ready") void hand();
});

// The second trigger. If the frame loaded before this script ran, its greeting
// is already gone and `load` is the only thing left to go on.
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
