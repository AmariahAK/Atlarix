/**
 * A plan as a page to share (`/plan share`): the markdown, rendered in the
 * browser by `marked` from cdnjs (which the relic CSP allows), styled like
 * Atlarix. If the CDN can't load, the plan still shows as plain text.
 */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function planPageHtml(title: string, markdown: string): string {
  // `</script>` inside the markdown would end the data block early.
  const data = markdown.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --bg: #ffffff; --muted: #666; --accent: #10b981; --line: #e5e5e5; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e5e5e5; --bg: #0a0a0a; --muted: #8a8a8a; --line: #2a2a2a; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, Segoe UI, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 40px 20px 80px; }
  .tag { color: var(--accent); font-weight: 600; font-size: 13px; letter-spacing: .02em; }
  h1, h2, h3 { line-height: 1.25; } h1 { font-size: 28px; } h2 { margin-top: 32px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; }
  pre { background: color-mix(in srgb, var(--fg) 6%, transparent); padding: 12px; border-radius: 8px; overflow-x: auto; }
  li:has(> input[type=checkbox]) { list-style: none; margin-left: -1.2em; }
  a { color: var(--accent); }
  #raw { white-space: pre-wrap; }
</style>
</head>
<body>
<main>
  <div class="tag">◆ Atlarix plan</div>
  <article id="plan"><pre id="raw">${esc(markdown)}</pre></article>
</main>
<script type="text/markdown" id="md">${data}</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js"></script>
<script>
  try {
    var md = document.getElementById("md").textContent;
    document.getElementById("plan").innerHTML = window.marked.parse(md, { gfm: true });
  } catch (e) { /* the plain text stays */ }
</script>
</body>
</html>
`;
}
