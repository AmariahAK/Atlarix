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

    if (document.readyState === "complete") report();
    else window.addEventListener("load", report);
    window.addEventListener("resize", report);
  }

  window.addEventListener("message", render);
  // Say we are ready, so the viewer does not have to race the frame's load.
  parent.postMessage({ kind: "atlarix:relic-ready" }, "*");
})();
