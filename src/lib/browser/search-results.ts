/**
 * Read search results off a rendered results page.
 *
 * WHY A REAL BROWSER AT ALL
 * -------------------------
 * Measured 2026-08-19, Core's `web_search` returned NOTHING: DuckDuckGo's Instant
 * Answer API gives 0 results for developer queries (it is an instant-ANSWER API,
 * never a web search), four of five public SearxNG instances answer HTTP 429, and
 * `searx.be` serves a "Verifying your browser…" challenge that parses to zero.
 * Every one of those is an "is this a real browser?" check — and Atlarix ships a
 * real Chromium. A plain `fetch` cannot pass them; a browser tab can.
 *
 * WHY NOT THE ACCESSIBILITY TREE
 * ------------------------------
 * The obvious idea is to reuse `a11y-snapshot.ts`, since an accessibility tree is
 * far more stable than CSS classes. It cannot work here: `A11yElement` carries
 * `role`, `name` and `text` but **no href**, and the URL is the entire point of a
 * search result.
 *
 * SO: STRUCTURE, NOT CLASS NAMES
 * ------------------------------
 * Engines rewrite their markup constantly and their class names mean nothing a
 * month later, so nothing here matches a class, id or data attribute. A result is
 * derived from shape instead: an anchor that leaves the engine's own host, carries
 * visible text of plausible title length, and sits outside the page's chrome. That
 * is still a heuristic — it is just the most durable one available, and every
 * caller treats an empty return as "fall through to the next tier", never an error.
 */

/** One extracted result. Mirrors `UnifiedSearchResult` minus the scoring fields. */
export interface ExtractedSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Shortest/longest visible anchor text that can plausibly be a result title. */
const MIN_TITLE = 12;
const MAX_TITLE = 300;

/**
 * Injected with `executeJavaScript(script, true)` — the same channel as
 * ERROR_HOOK_SCRIPT and the a11y snapshot — and RETURNS its value, rather than
 * relaying through a console sentinel, because the caller is awaiting one answer
 * rather than subscribing to a stream of events.
 *
 * Guards, each earning its place:
 * - skips the page's own host, so engine navigation, account links, settings and
 *   footer promos never look like results;
 * - skips anchors inside `nav`/`header`/`footer`/`aside`, which is where the
 *   remaining chrome lives;
 * - requires plausible title length, which drops "Next", "Images", icon links and
 *   the single-word junk that survives everything else;
 * - de-duplicates by URL, since engines repeat a destination as title + sitelink;
 * - takes the snippet from the nearest ancestor that has meaningfully more text
 *   than the anchor itself, then removes the title from it, so the snippet is not
 *   just the title again;
 * - preserves document order, which is the engine's ranking and the only ranking
 *   signal available;
 * - and the whole body is wrapped so a page that breaks it yields `[]` rather than
 *   rejecting the caller's promise.
 */
export const SEARCH_RESULTS_SCRIPT = `(() => {
  try {
    var MIN_TITLE = ${MIN_TITLE};
    var MAX_TITLE = ${MAX_TITLE};
    var out = [];
    var seen = Object.create(null);
    var host = location.hostname.replace(/^www\\./, "");

    function inChrome(el) {
      for (var n = el; n && n !== document.body; n = n.parentElement) {
        var tag = (n.tagName || "").toLowerCase();
        if (tag === "nav" || tag === "header" || tag === "footer" || tag === "aside") {
          return true;
        }
        var role = n.getAttribute && n.getAttribute("role");
        if (role === "navigation" || role === "banner" || role === "contentinfo") {
          return true;
        }
      }
      return false;
    }

    function clean(s) { return (s || "").replace(/\\s+/g, " ").trim(); }

    // Engines render a result as [site label] [breadcrumb] [title] in separate
    // blocks. In a real browser \`innerText\` puts each on its own LINE, so the
    // title is recoverable: take the last line that is still a plausible title.
    // (Under jsdom there is no layout and \`textContent\` runs them together, which
    // is why the fixture test sees some titles with a breadcrumb prefix — the
    // degraded path, not the shipping one.)
    function titleOf(a) {
      var raw = a.innerText || a.textContent || "";
      var lines = String(raw).split("\\n").map(clean).filter(Boolean);
      if (lines.length > 1) {
        var last = lines[lines.length - 1];
        if (last.length >= MIN_TITLE && last.length <= MAX_TITLE) return last;
      }
      return clean(raw);
    }

    // The snippet is the nearest ancestor carrying materially more text than the
    // link itself — engines nest the description beside the title, not inside it.
    function snippetFor(a, title) {
      var node = a;
      for (var i = 0; i < 4 && node && node.parentElement; i++) {
        node = node.parentElement;
        var text = clean(node.innerText || node.textContent);
        if (text.length > title.length + 40) {
          var body = clean(text.split(title).join(" "));
          if (body.length > 20) return body.slice(0, 400);
        }
      }
      return "";
    }

    var anchors = document.querySelectorAll('a[href^="http://"], a[href^="https://"]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var url = a.href;
      if (!url) continue;

      var h;
      try { h = new URL(url).hostname.replace(/^www\\./, ""); } catch (e) { continue; }
      // Same-site links are the engine's own furniture, never a result.
      if (!h || h === host || h.indexOf("." + host) === h.length - host.length - 1) continue;
      if (inChrome(a)) continue;

      var title = titleOf(a);
      if (title.length < MIN_TITLE || title.length > MAX_TITLE) continue;

      // A destination usually has SEVERAL anchors: a wrapper around the whole
      // result card, and the title link itself. The wrapper's text swallows the
      // site label and breadcrumb ("GitHub github.com › owner › repo › issues ›
      // 108"), so taking the first one seen produced titles full of chrome.
      // The TIGHTEST anchor around a URL is the title — a wrapper can only ever
      // accumulate more text — so keep the shortest plausible one.
      var prev = seen[url];
      if (prev) {
        if (title.length < prev.title.length) {
          prev.title = title;
          prev.snippet = snippetFor(a, title) || prev.snippet;
        }
        continue;
      }
      var rec = { title: title, url: url, snippet: snippetFor(a, title) };
      seen[url] = rec;
      out.push(rec);
    }
    return out;
  } catch (e) {
    return [];
  }
})();`;
