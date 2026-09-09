/**
 * Visual "sight" for the preview / in-app browser — token-efficient rendering
 * checks that let any model SEE whether the page renders correctly WITHOUT
 * spending thousands of vision tokens on a screenshot.
 *
 * Two hybrid layers, both injected via `executeJavaScript(script, true)` (the
 * same isolated-world channel as `a11y-snapshot.ts`; the scripts are static
 * templates with NO model input interpolated, so they carry no injection
 * surface):
 *   1. axe-core — contrast / structure / perceivable defects (bundled + inlined
 *      via Vite `?raw`, run in-page as `window.axe`).
 *   2. Hand-rolled DOM rules — the Atlarix-specific defects axe doesn't cover:
 *      blank render, broken <img>, invisible text (color≈background), collapsed
 *      zero-size containers, gross sibling overlap.
 * Plus CLS from `web-vitals` (installed at preview load, read on demand).
 *
 * Everything returns a compact TEXT report (findings + counts), never raw
 * geometry per node — that's the whole point (~500 tokens vs ~5k–50k for an
 * image), and it's MORE accurate than vision for structural facts.
 */

import axeSource from "axe-core/axe.min.js?raw";
// web-vitals' `exports` map blocks the bare `web-vitals/dist/...iife.js` subpath,
// so we import the IIFE bundle by relative path (bypasses the exports gate). The
// IIFE defines `var webVitals`, captured inside CLS_OBSERVER_SCRIPT's own scope.
import webVitalsSource from "../../../node_modules/web-vitals/dist/web-vitals.iife.js?raw";

/** Cap findings so a pathological page can't bloat the result. */
const MAX_DEFECTS = 25;
const MAX_AXE_VIOLATIONS = 15;

/** axe rules that map to VISUAL/perceivable defects (not the full a11y suite). */
const AXE_VISUAL_RULES = [
  "color-contrast",
  "image-alt",
  "link-name",
  "button-name",
  "label",
  "link-in-text-block",
];

export interface VisualDefect {
  /** Machine rule id (e.g. "broken-image", "invisible-text", "color-contrast"). */
  rule: string;
  /** "critical" | "serious" | "moderate" — for ranking in the report. */
  impact: string;
  /** One-line human description. */
  message: string;
  /** A short CSS-ish locator for the first offending node. */
  target?: string;
  /** How many nodes hit this rule (axe groups by rule). */
  count?: number;
}

export interface VisualLintReport {
  url: string;
  title: string;
  /** Cumulative Layout Shift since page load (null if not yet measured). */
  cls: number | null;
  /** Total interactive/visible element count — a cheap "did it render" signal. */
  elementCount: number;
  defects: VisualDefect[];
  truncated: boolean;
}

/**
 * Injected at preview LOAD (before layout shifts happen) so CLS accumulates from
 * the start. Idempotent per page context. Inlines the web-vitals IIFE (defines
 * `self.webVitals`) and stashes the running CLS on a page global the linter reads.
 */
export const CLS_OBSERVER_SCRIPT = `(() => {
  try {
    if (window.__atlarixCLSInit) return;
    window.__atlarixCLSInit = true;
    window.__atlarixCLS = 0;
    ${webVitalsSource}
    if (typeof webVitals !== "undefined" && webVitals.onCLS) {
      webVitals.onCLS(function (metric) { window.__atlarixCLS = metric.value; }, { reportAllChanges: true });
    }
  } catch (e) { /* best-effort — never break the page */ }
})()`;

/** Ensure `window.axe` exists in the page (inject the bundled source once). */
async function ensureAxe(wc: Electron.WebContents): Promise<boolean> {
  try {
    const present = (await wc.executeJavaScript(
      "typeof window.axe !== 'undefined'",
      true,
    )) as boolean;
    if (present) return true;
    await wc.executeJavaScript(axeSource, true);
    return (await wc.executeJavaScript(
      "typeof window.axe !== 'undefined'",
      true,
    )) as boolean;
  } catch {
    return false;
  }
}

/**
 * Combined analysis script: hand-rolled DOM defect walker + axe run + CLS read.
 * Static template (no interpolation of untrusted/model input). Returns a plain
 * object the main process shapes into a VisualLintReport.
 */
const VISUAL_LINT_SCRIPT = `(async () => {
  const MAX = ${MAX_DEFECTS};
  const defects = [];
  const push = (rule, impact, message, target) => {
    if (defects.length < MAX) defects.push({ rule, impact, message, target });
  };
  const locator = (el) => {
    try {
      if (!el) return undefined;
      const id = el.id ? '#' + el.id : '';
      const cls = (el.className && typeof el.className === 'string')
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
      return (el.tagName ? el.tagName.toLowerCase() : '') + id + cls;
    } catch (e) { return undefined; }
  };

  const body = document.body;
  const allEls = document.querySelectorAll('body *');
  const elementCount = allEls.length;
  const bodyText = ((body && body.innerText) || '').trim();
  const hasMedia = !!document.querySelector('img,canvas,svg,video');

  // 1) Blank render / white-screen — no text, almost no elements, no media.
  if (!body || (bodyText.length === 0 && elementCount < 3 && !hasMedia)) {
    push('blank-render', 'critical', 'Page rendered blank (no visible text, elements, or media).');
  }

  // Walk a bounded slice for the geometry/style rules.
  const els = Array.from(allEls).slice(0, 4000);
  let broken = 0, invisible = 0, collapsed = 0, overlapped = 0;
  const seenOverlap = new Set();
  for (const el of els) {
    try {
      // 2) Broken images (loaded but zero natural size).
      if (el.tagName === 'IMG' && el.complete && el.naturalWidth === 0 && el.getAttribute('src')) {
        broken++;
        if (broken <= 5) push('broken-image', 'serious', 'Broken image (failed to load): ' + (el.getAttribute('src') || '').slice(0, 80), locator(el));
        continue;
      }
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      const ownText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent && n.textContent.trim());

      // 3) Invisible text — element with its own text whose color equals its
      //    background (a common CSS mistake that vision would miss).
      if (ownText) {
        const c = style.color, bg = style.backgroundColor;
        if (c && bg && c === bg && bg !== 'rgba(0, 0, 0, 0)') {
          invisible++;
          if (invisible <= 5) push('invisible-text', 'serious', 'Text color equals background color (text invisible).', locator(el));
        }
      }

      // 4) Collapsed container — has element children but zero rendered height.
      if (el.children.length >= 2 && rect.height === 0 && rect.width > 0) {
        collapsed++;
        if (collapsed <= 5) push('collapsed-layout', 'moderate', 'Container has children but zero height (layout collapsed).', locator(el));
      }
    } catch (e) { /* skip element */ }
  }

  // 5) Gross sibling overlap — two IN-FLOW, opaque, TEXT-BEARING block siblings
  //    whose boxes overlap > 60%. Decorative layers (absolutely/fixed-positioned
  //    backdrops, glows, near-transparent or pointer-events:none overlays, and
  //    textless boxes) overlap content BY DESIGN, so skip them — otherwise every
  //    modern site reports false "layout bugs" (a single decorative element flags
  //    against everything below it).
  try {
    const blocks = Array.from(document.querySelectorAll('main *, body > *')).slice(0, 400);
    const isDecorativeLayer = (el) => {
      try {
        const s = window.getComputedStyle(el);
        if (s.position === 'absolute' || s.position === 'fixed') return true;
        if (s.pointerEvents === 'none') return true;
        if (parseFloat(s.opacity || '1') < 0.1) return true;
        if (!((el.textContent || '').trim())) return true; // backdrop/glow, no text
        return false;
      } catch (e) { return true; }
    };
    for (let i = 0; i < blocks.length && overlapped < 5; i++) {
      const a = blocks[i].getBoundingClientRect();
      if (a.width < 8 || a.height < 8) continue;
      if (isDecorativeLayer(blocks[i])) continue;
      for (let j = i + 1; j < blocks.length; j++) {
        if (blocks[i].contains(blocks[j]) || blocks[j].contains(blocks[i])) continue;
        if (isDecorativeLayer(blocks[j])) continue;
        const b = blocks[j].getBoundingClientRect();
        const ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const area = ox * oy;
        const minArea = Math.min(a.width * a.height, b.width * b.height);
        if (minArea > 0 && area / minArea > 0.6) {
          const key = i + ':' + j;
          if (!seenOverlap.has(key)) {
            seenOverlap.add(key);
            overlapped++;
            push('sibling-overlap', 'moderate', 'Two content elements overlap by >60% (possible layout issue; decorative/positioned layers are excluded).', locator(blocks[i]) + ' / ' + locator(blocks[j]));
          }
          break;
        }
      }
    }
  } catch (e) { /* best-effort */ }

  // 6) axe-core — contrast / structure (bounded rule set, violations only).
  let axeViolations = [];
  try {
    if (window.axe) {
      const r = await window.axe.run(document, {
        runOnly: { type: 'rule', values: ${JSON.stringify(AXE_VISUAL_RULES)} },
        resultTypes: ['violations'],
        elementRef: false,
      });
      axeViolations = (r.violations || []).slice(0, ${MAX_AXE_VIOLATIONS}).map((v) => ({
        rule: v.id,
        impact: v.impact || 'moderate',
        message: v.help,
        target: (v.nodes && v.nodes[0] && v.nodes[0].target && v.nodes[0].target[0]) ? String(v.nodes[0].target[0]).slice(0, 80) : undefined,
        count: (v.nodes || []).length,
      }));
    }
  } catch (e) { /* axe optional */ }

  return {
    url: location.href,
    title: document.title,
    cls: typeof window.__atlarixCLS === 'number' ? window.__atlarixCLS : null,
    elementCount,
    defects,
    axeViolations,
    truncated: defects.length >= MAX,
  };
})()`;

/** Run the visual linter against a page; null on failure. */
export async function runVisualLint(
  wc: Electron.WebContents,
): Promise<VisualLintReport | null> {
  await ensureAxe(wc); // best-effort; hand-rolled rules still run without axe
  try {
    const raw = (await wc.executeJavaScript(VISUAL_LINT_SCRIPT, true)) as {
      url: string;
      title: string;
      cls: number | null;
      elementCount: number;
      defects: VisualDefect[];
      axeViolations: VisualDefect[];
      truncated: boolean;
    } | null;
    if (!raw) return null;
    // Merge hand-rolled + axe, rank by impact, cap.
    const rank: Record<string, number> = {
      critical: 0,
      serious: 1,
      moderate: 2,
    };
    const defects = [...(raw.defects ?? []), ...(raw.axeViolations ?? [])]
      .sort((a, b) => (rank[a.impact] ?? 3) - (rank[b.impact] ?? 3))
      .slice(0, MAX_DEFECTS);
    return {
      url: raw.url,
      title: raw.title,
      cls: raw.cls,
      elementCount: raw.elementCount,
      defects,
      truncated: raw.truncated || defects.length >= MAX_DEFECTS,
    };
  } catch {
    return null;
  }
}

/** Render a VisualLintReport as compact text the model reads. */
export function formatVisualLintReport(r: VisualLintReport): string {
  const clsLine =
    r.cls != null
      ? `CLS (layout shift): ${r.cls.toFixed(3)}${r.cls > 0.1 ? " — above the 0.1 'good' threshold" : " (good)"}`
      : "CLS: not measured";
  if (r.defects.length === 0) {
    return `Visual lint — no defects found. ${r.elementCount} elements rendered. ${clsLine}. The page appears to render correctly.`;
  }
  const lines = r.defects.map(
    (d) =>
      `- [${d.impact}] ${d.rule}: ${d.message}${d.count && d.count > 1 ? ` (${d.count} nodes)` : ""}${d.target ? ` — ${d.target}` : ""}`,
  );
  return (
    `Visual lint — ${r.defects.length} defect(s)${r.truncated ? " (capped)" : ""} on ${r.url}. ${r.elementCount} elements. ${clsLine}.\n` +
    lines.join("\n") +
    `\nFix the cause and re-inspect with browser_inspect mode:"visual".`
  );
}

// ── Design snapshot (for "look at this URL and remake it") ───────────────────

export interface DesignSnapshot {
  url: string;
  title: string;
  palette: { color: string; count: number }[];
  fontFamilies: string[];
  typeScale: string[];
  spacing: string[];
  layout: string[];
}

/** Extract palette / type scale / spacing / layout from computed styles as TEXT. */
const DESIGN_SNAPSHOT_SCRIPT = `(() => {
  const els = Array.from(document.querySelectorAll('body *')).slice(0, 3000);
  const colorCount = new Map();
  const fonts = new Set();
  const sizes = new Set();
  const spaces = new Set();
  const bump = (map, k) => { if (k) map.set(k, (map.get(k) || 0) + 1); };
  for (const el of els) {
    try {
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (s.color) bump(colorCount, s.color);
      if (s.backgroundColor && s.backgroundColor !== 'rgba(0, 0, 0, 0)') bump(colorCount, s.backgroundColor);
      if (s.fontFamily) fonts.add(s.fontFamily.split(',')[0].replace(/["']/g, '').trim());
      const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent && n.textContent.trim());
      if (hasText && s.fontSize) sizes.add(s.fontSize + ' / ' + s.fontWeight);
      for (const p of [s.paddingTop, s.paddingLeft, s.marginTop, s.gap]) {
        if (p && p !== '0px' && /px$/.test(p)) spaces.add(p);
      }
    } catch (e) { /* skip */ }
  }
  const palette = [...colorCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([color, count]) => ({ color, count }));
  const sortPx = (arr) => arr.sort((a, b) => parseFloat(a) - parseFloat(b));
  const layout = [];
  for (const sel of ['header', 'nav', 'main', 'aside', 'footer', 'section']) {
    const el = document.querySelector(sel);
    if (el) {
      const r = el.getBoundingClientRect();
      layout.push(sel + ': ' + Math.round(r.width) + '×' + Math.round(r.height));
    }
  }
  return {
    url: location.href,
    title: document.title,
    palette,
    fontFamilies: [...fonts].slice(0, 6),
    typeScale: sortPx([...sizes]).slice(0, 12),
    spacing: sortPx([...spaces]).slice(0, 12),
    layout,
  };
})()`;

/** Run the design-snapshot extractor against a page; null on failure. */
export async function runDesignSnapshot(
  wc: Electron.WebContents,
): Promise<DesignSnapshot | null> {
  try {
    const raw = (await wc.executeJavaScript(
      DESIGN_SNAPSHOT_SCRIPT,
      true,
    )) as DesignSnapshot | null;
    if (!raw || !Array.isArray(raw.palette)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Render a DesignSnapshot as compact text (the source of truth for a remake). */
export function formatDesignSnapshot(d: DesignSnapshot): string {
  const palette =
    d.palette.map((p) => `${p.color} (×${p.count})`).join(", ") || "none";
  return [
    `Design snapshot — ${d.url}`,
    `Palette (most-used first): ${palette}`,
    `Fonts: ${d.fontFamilies.join(", ") || "default"}`,
    `Type scale (size / weight): ${d.typeScale.join(", ") || "n/a"}`,
    `Spacing units: ${d.spacing.join(", ") || "n/a"}`,
    `Layout regions: ${d.layout.join(", ") || "no semantic landmarks"}`,
  ].join("\n");
}

// ── Blank-render check (conservative done-gate) ──────────────────────────────

/**
 * High-confidence "did the app render anything?" check for the completion gate.
 * Deliberately narrow (no text AND < 3 elements AND no media) so it only trips
 * on a genuine white-screen — never on a normally-rendered page. Returns null
 * when it cannot tell (no page / not navigated) so the gate never false-blocks.
 */
export async function detectBlankRender(
  wc: Electron.WebContents,
): Promise<{ blank: boolean; reason: string } | null> {
  try {
    const url = wc.getURL();
    if (!url || url === "about:blank" || url.startsWith("chrome-error://"))
      return null;
    return (await wc.executeJavaScript(
      `(() => {
        const b = document.body;
        if (!b) return { blank: true, reason: 'no document body' };
        const text = (b.innerText || '').trim();
        const els = document.querySelectorAll('body *').length;
        const media = !!document.querySelector('img,canvas,svg,video');
        if (text.length === 0 && els < 3 && !media) return { blank: true, reason: 'empty body — no text, elements, or media' };
        return { blank: false, reason: '' };
      })()`,
      true,
    )) as { blank: boolean; reason: string };
  } catch {
    return null;
  }
}
