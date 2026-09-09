/**
 * Page-side `fetch`/XHR instrumentation — the fallback tier's ONLY source of
 * response bodies.
 *
 * When CDP is live, bodies come from `Network.getResponseBody` and none of this
 * runs. When attach fails, `webRequest` gives a complete request inventory but
 * cannot see a single byte of a response, so the bodies have to be taken from
 * inside the page.
 *
 * Transport is the console sentinel, exactly like `ERROR_HOOK_SCRIPT`: browser
 * tabs deliberately have no preload (an arbitrary web page must never get an IPC
 * bridge), so `console.error` with a magic prefix is the channel available.
 *
 * Two honest limits, both worth stating rather than papering over:
 *   - **It misses early requests.** Injection happens at `dom-ready` at the
 *     earliest, which is after the page's own head scripts have run. CDP does not
 *     have this gap because it can inject at document-start.
 *   - **It only sees `fetch` and `XHR`.** Documents, scripts, images and
 *     `sendBeacon` go through neither, so those rows keep an inventory entry with
 *     no body. That is a gap in the tier, not a bug in the row.
 */

export const NETWORK_SENTINEL = "[[ATLARIX_NET]]";

/** Body cap, page-side. Applied before the string ever crosses into the main process. */
export const NETWORK_BODY_MAX = 4000;

/**
 * A response body observed inside the page. Correlated back to a `webRequest`
 * entry by `METHOD url` — the two tiers share no request id.
 */
export type CapturedResponseBody = {
  method: string;
  url: string;
  status?: number;
  body?: string;
  truncated?: boolean;
  failed?: boolean;
  errorText?: string;
};

/**
 * Injected into a DEGRADED tab (idempotent per document — a window flag guards
 * re-injection at both `dom-ready` and `did-finish-load`).
 *
 * Written defensively throughout: this runs inside a page the user is browsing,
 * and a wrapper that throws breaks that page. Every hook is try/caught, the
 * original is always called, and its return value is always passed through
 * untouched.
 */
export const NETWORK_HOOK_SCRIPT = `(() => {
  try {
    if (window.__atlarixNetHook) return;
    window.__atlarixNetHook = true;
    var SENT = ${JSON.stringify(NETWORK_SENTINEL)};
    var MAX = ${NETWORK_BODY_MAX};
    // Bind the real console.error up front: if the page later wraps console
    // itself (analytics libraries do), our records must not travel through it.
    var OUT = console.error.bind(console);
    function emit(rec) { try { OUT(SENT + JSON.stringify(rec)); } catch (e) {} }
    function textual(ct) { return !ct || /json|text|xml|javascript|urlencoded/i.test(ct); }
    function clip(t) {
      return { body: t.length > MAX ? t.slice(0, MAX) : t, truncated: t.length > MAX };
    }

    var origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (input, init) {
        var url = "", method = "GET";
        try {
          url = typeof input === "string" ? input : (input && input.url) || "";
          method = (init && init.method) || (input && input.method) || "GET";
        } catch (e) {}
        var p = origFetch.apply(this, arguments);
        try {
          p.then(function (res) {
            try {
              var ct = res.headers && res.headers.get ? res.headers.get("content-type") : "";
              var finalUrl = url || res.url || "";
              if (!textual(ct)) { emit({ method: method, url: finalUrl, status: res.status }); return; }
              // clone() so the page still gets an unread body — reading the
              // original would break every caller.
              res.clone().text().then(function (t) {
                var c = clip(t);
                emit({ method: method, url: finalUrl, status: res.status, body: c.body, truncated: c.truncated });
              }, function () {
                emit({ method: method, url: finalUrl, status: res.status });
              });
            } catch (e) {}
          }, function (err) {
            emit({
              method: method, url: url, failed: true,
              errorText: String((err && err.message) || err || "fetch failed"),
            });
          });
        } catch (e) {}
        return p;
      };
    }

    var proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (proto && typeof proto.open === "function" && typeof proto.send === "function") {
      var origOpen = proto.open, origSend = proto.send;
      proto.open = function (m, u) {
        try { this.__atlarixM = m; this.__atlarixU = u; } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      proto.send = function () {
        var self = this;
        try {
          self.addEventListener("loadend", function () {
            try {
              var m = self.__atlarixM || "GET", u = self.__atlarixU || "";
              // status 0 after loadend means it never completed: network error,
              // abort, or a CORS rejection. All three are worth recording.
              if (!self.status) {
                emit({ method: m, url: u, failed: true, errorText: "request failed, aborted, or blocked" });
                return;
              }
              var body, truncated;
              // responseText throws for binary responseTypes — only read it when
              // the response is declared textual.
              if (self.responseType === "" || self.responseType === "text") {
                var c = clip(String(self.responseText || ""));
                body = c.body; truncated = c.truncated;
              }
              emit({ method: m, url: u, status: self.status, body: body, truncated: truncated });
            } catch (e) {}
          });
        } catch (e) {}
        return origSend.apply(this, arguments);
      };
    }
  } catch (e) { /* never break the page */ }
})();`;

/**
 * Parse a `[[ATLARIX_NET]]` console message back into a body record. Returns null
 * for anything else so the ordinary console path keeps handling it.
 */
export function tryParseNetworkSentinel(
  message: string,
): CapturedResponseBody | null {
  const idx = message.indexOf(NETWORK_SENTINEL);
  if (idx === -1) return null;
  try {
    const rec = JSON.parse(
      message.slice(idx + NETWORK_SENTINEL.length).trim(),
    ) as Partial<CapturedResponseBody>;
    if (!rec || typeof rec.url !== "string") return null;
    return {
      method: typeof rec.method === "string" ? rec.method : "GET",
      url: rec.url,
      status: typeof rec.status === "number" ? rec.status : undefined,
      // Re-clip on this side too: the cap above is enforced by a script running
      // in a hostile document, so it is a courtesy, not a guarantee.
      body:
        typeof rec.body === "string"
          ? rec.body.slice(0, NETWORK_BODY_MAX)
          : undefined,
      truncated:
        rec.truncated === true ||
        (typeof rec.body === "string" && rec.body.length > NETWORK_BODY_MAX),
      failed: rec.failed === true,
      errorText: typeof rec.errorText === "string" ? rec.errorText : undefined,
    };
  } catch {
    return null;
  }
}
