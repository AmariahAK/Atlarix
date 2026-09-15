/*
 * Receive one relic and become it.
 *
 * `document.write` RATHER THAN `innerHTML`, and this is the one file in the
 * extension where that is the right call. `innerHTML` does not execute a
 * `<script>` tag it inserts, so a relic that draws a chart would render its
 * markup and then sit there dead — the failure would look like a broken
 * feature rather than a security boundary doing its job. `document.write`
 * parses the document the way a document is parsed.
 *
 * It is safe HERE and nowhere else in this codebase, because this page is an
 * opaque origin with no `chrome.*`, no same-origin handle to the extension and
 * no network (`connect-src 'none'` in the manifest's sandbox CSP). There is
 * nothing in reach to steal and nowhere to send it.
 *
 * ONE RELIC, ONCE. The listener is removed before the write, because the write
 * replaces this document — including this script — and a second message
 * arriving mid-parse would be a second document interleaved with the first.
 */
(function () {
  "use strict";

  function render(event) {
    var data = event && event.data;
    if (!data || data.kind !== "atlarix:relic" || typeof data.html !== "string") {
      return;
    }
    // Removed FIRST. The parent re-offers the relic until it hears back, so a
    // second copy can be in flight while this one is being written, and the
    // write replaces the document this listener lives in.
    window.removeEventListener("message", render);

    // Tell the host how tall the content turned out, so the viewer can size the
    // frame instead of guessing. Sent after the document settles; a relic that
    // draws asynchronously reports again on resize.
    function report() {
      var height = Math.max(
        document.documentElement ? document.documentElement.scrollHeight : 0,
        document.body ? document.body.scrollHeight : 0,
      );
      // `*` is the only target available: this page has an opaque origin, so
      // there is no origin string the parent would match. The parent checks the
      // frame identity instead, which is the check that means anything here.
      parent.postMessage({ kind: "atlarix:relic-height", height: height }, "*");
    }

    document.open();
    document.write(data.html);
    document.close();
    watchViolations(document);

    // THE ACKNOWLEDGEMENT THE PARENT IS WAITING FOR. Sent the instant the write
    // completes rather than folded into the height report, because the height
    // report waits on `load` — and a parent still retrying because a load event
    // was slow would re-write a document that is already on screen.
    parent.postMessage({ kind: "atlarix:relic-shown" }, "*");

    if (document.readyState === "complete") report();
    else window.addEventListener("load", report);
    window.addEventListener("resize", report);
  }

  /*
   * A BLANK RELIC HAS TO SAY WHY.
   *
   * Every resource this document is refused fires `securitypolicyviolation`
   * here — and the one that matters, a script that was going to build the whole
   * interface, leaves a white page with nothing on it and nothing in the user's
   * way to explain it. Reporting the blocked URL to the viewer turns "it is
   * broken" into "it wanted the network, and relics do not have one".
   *
   * Registered on `document` BEFORE the write, and again after, because the
   * write replaces the document this listener was attached to.
   */
  function watchViolations(doc) {
    doc.addEventListener("securitypolicyviolation", function (e) {
      parent.postMessage(
        {
          kind: "atlarix:relic-blocked",
          uri: String(e.blockedURI || ""),
          directive: String(e.effectiveDirective || e.violatedDirective || ""),
        },
        "*",
      );
    });
  }

  watchViolations(document);
  window.addEventListener("message", render);
  // Say we are ready, so the viewer does not have to race the frame's load.
  parent.postMessage({ kind: "atlarix:relic-ready" }, "*");
})();
