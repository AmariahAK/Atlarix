/**
 * The visual and design reports, as functions that run in the page realm.
 *
 * WHY THESE ARE NOT KERNEL OPS. `atlarixPageKernel` is synchronous, and the
 * visual report has to `await axe.run()`. Rather than make every kernel op
 * return a promise, these are two more portable functions under the SAME rules
 * as the kernel (see `index.ts`): the extension hands each one straight to
 * `chrome.scripting.executeScript` as `func`, with JSON-serializable `args`.
 *
 *   1. No imports, and nothing inside a function may reference module scope —
 *      a stringified function does not carry its module. Caps arrive as args.
 *   2. No backtick inside a function body — a template literal compiles to
 *      the same, and keeps the serialized source spliceable.
 *   3. No TypeScript feature that needs an emit helper.
 *
 * They used to be `VISUAL_LINT_SCRIPT` / `DESIGN_SNAPSHOT_SCRIPT`, strings the
 * in-app browser ran through `executeJavaScript`. MV3 cannot execute a string,
 * so moving the agent to the user's Chrome (v14.52.0) meant converting them —
 * the same string-to-function move the kernel itself went through.
 *
 * axe-core is injected SEPARATELY, as a packaged file (`vendor/axe.min.js`),
 * before `atlarixVisualLint` runs. If it is missing the hand-rolled rules still
 * run; axe only adds the contrast / accessible-name findings.
 */

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

export interface VisualLintArgs {
  maxDefects: number;
  maxAxe: number;
  axeRules: string[];
}

export interface VisualLintRaw {
  url: string;
  title: string;
  /** Cumulative Layout Shift (largest session window), null if unmeasurable. */
  cls: number | null;
  elementCount: number;
  defects: VisualDefect[];
  axeViolations: VisualDefect[];
  axeAvailable: boolean;
  truncated: boolean;
}

export interface DesignSnapshot {
  url: string;
  title: string;
  palette: { color: string; count: number }[];
  fontFamilies: string[];
  typeScale: string[];
  spacing: string[];
  layout: string[];
}

/**
 * Hand-rolled DOM defect walker + axe (when present) + CLS.
 *
 * CLS comes from a BUFFERED `PerformanceObserver`, so nothing has to be
 * installed before the page loads — the old in-app browser injected web-vitals
 * at load for exactly that reason, and a user's Chrome tab gives us no such
 * hook. `takeRecords()` returns the buffered layout-shift entries synchronously.
 * Windows follow the web-vitals definition: shifts less than 1s apart, capped at
 * 5s, largest window wins; shifts right after user input are excluded.
 */
export async function atlarixVisualLint(
  opts: VisualLintArgs,
): Promise<VisualLintRaw> {
  const MAX = opts.maxDefects;
  const defects: VisualDefect[] = [];
  const push = (
    rule: string,
    impact: string,
    message: string,
    target?: string,
  ) => {
    if (defects.length < MAX) defects.push({ rule, impact, message, target });
  };
  const locator = (el: Element | null): string | undefined => {
    try {
      if (!el) return undefined;
      const id = el.id ? "#" + el.id : "";
      const rawCls = (el as HTMLElement).className;
      const cls =
        rawCls && typeof rawCls === "string" && rawCls.trim()
          ? "." + rawCls.trim().split(/\s+/).slice(0, 2).join(".")
          : "";
      return (el.tagName ? el.tagName.toLowerCase() : "") + id + cls;
    } catch {
      return undefined;
    }
  };

  const body = document.body;
  const allEls = document.querySelectorAll("body *");
  const elementCount = allEls.length;
  const bodyText = ((body && body.innerText) || "").trim();
  const hasMedia = !!document.querySelector("img,canvas,svg,video");

  // 1) Blank render / white-screen — no text, almost no elements, no media.
  if (!body || (bodyText.length === 0 && elementCount < 3 && !hasMedia)) {
    push(
      "blank-render",
      "critical",
      "Page rendered blank (no visible text, elements, or media).",
    );
  }

  const els = Array.from(allEls).slice(0, 4000);
  let broken = 0;
  let invisible = 0;
  let collapsed = 0;
  for (const el of els) {
    try {
      // 2) Broken images (loaded but zero natural size).
      if (
        el.tagName === "IMG" &&
        (el as HTMLImageElement).complete &&
        (el as HTMLImageElement).naturalWidth === 0 &&
        el.getAttribute("src")
      ) {
        broken++;
        if (broken <= 5) {
          push(
            "broken-image",
            "serious",
            "Broken image (failed to load): " +
              (el.getAttribute("src") || "").slice(0, 80),
            locator(el),
          );
        }
        continue;
      }
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      const ownText = Array.from(el.childNodes).some(
        (n) => n.nodeType === 3 && n.textContent && n.textContent.trim(),
      );

      // 3) Invisible text — own text whose color equals its background.
      if (ownText) {
        const c = style.color;
        const bg = style.backgroundColor;
        if (c && bg && c === bg && bg !== "rgba(0, 0, 0, 0)") {
          invisible++;
          if (invisible <= 5) {
            push(
              "invisible-text",
              "serious",
              "Text color equals background color (text invisible).",
              locator(el),
            );
          }
        }
      }

      // 4) Collapsed container — has element children but zero rendered height.
      if (el.children.length >= 2 && rect.height === 0 && rect.width > 0) {
        collapsed++;
        if (collapsed <= 5) {
          push(
            "collapsed-layout",
            "moderate",
            "Container has children but zero height (layout collapsed).",
            locator(el),
          );
        }
      }
    } catch {
      /* skip element */
    }
  }

  // 5) Gross sibling overlap — two IN-FLOW, opaque, TEXT-BEARING blocks whose
  //    boxes overlap > 60%. Decorative layers (positioned backdrops, glows,
  //    transparent or pointer-events:none overlays, textless boxes) overlap
  //    content BY DESIGN and are skipped — including Atlarix's own "driven"
  //    frame, which is fixed and pointer-events:none.
  try {
    const blocks = Array.from(
      document.querySelectorAll("main *, body > *"),
    ).slice(0, 400);
    const isDecorativeLayer = (el: Element): boolean => {
      try {
        const s = window.getComputedStyle(el);
        if (s.position === "absolute" || s.position === "fixed") return true;
        if (s.pointerEvents === "none") return true;
        if (parseFloat(s.opacity || "1") < 0.1) return true;
        if (!(el.textContent || "").trim()) return true;
        return false;
      } catch {
        return true;
      }
    };
    let overlapped = 0;
    for (let i = 0; i < blocks.length && overlapped < 5; i++) {
      const a = blocks[i].getBoundingClientRect();
      if (a.width < 8 || a.height < 8) continue;
      if (isDecorativeLayer(blocks[i])) continue;
      for (let j = i + 1; j < blocks.length; j++) {
        if (blocks[i].contains(blocks[j]) || blocks[j].contains(blocks[i])) {
          continue;
        }
        if (isDecorativeLayer(blocks[j])) continue;
        const b = blocks[j].getBoundingClientRect();
        const ox = Math.max(
          0,
          Math.min(a.right, b.right) - Math.max(a.left, b.left),
        );
        const oy = Math.max(
          0,
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
        );
        const minArea = Math.min(a.width * a.height, b.width * b.height);
        if (minArea > 0 && (ox * oy) / minArea > 0.6) {
          overlapped++;
          push(
            "sibling-overlap",
            "moderate",
            "Two content elements overlap by >60% (possible layout issue; decorative/positioned layers are excluded).",
            locator(blocks[i]) + " / " + locator(blocks[j]),
          );
          break;
        }
      }
    }
  } catch {
    /* best-effort */
  }

  // 6) axe-core — contrast / structure (bounded rule set, violations only).
  const w = window as unknown as {
    axe?: {
      run: (
        ctx: Document,
        o: unknown,
      ) => Promise<{
        violations?: Array<{
          id: string;
          impact?: string;
          help: string;
          nodes?: Array<{ target?: unknown[] }>;
        }>;
      }>;
    };
  };
  const axeAvailable = !!w.axe;
  let axeViolations: VisualDefect[] = [];
  if (w.axe) {
    try {
      const r = await w.axe.run(document, {
        runOnly: { type: "rule", values: opts.axeRules },
        resultTypes: ["violations"],
        elementRef: false,
      });
      axeViolations = (r.violations || []).slice(0, opts.maxAxe).map((v) => {
        const first = v.nodes && v.nodes[0] && v.nodes[0].target;
        return {
          rule: v.id,
          impact: v.impact || "moderate",
          message: v.help,
          target: first && first[0] ? String(first[0]).slice(0, 80) : undefined,
          count: (v.nodes || []).length,
        };
      });
    } catch {
      /* axe optional */
    }
  }

  // 7) CLS from the buffered layout-shift entries.
  let cls: number | null = null;
  try {
    const po = new PerformanceObserver(() => {});
    po.observe({ type: "layout-shift", buffered: true });
    const records = po.takeRecords() as unknown as Array<{
      value: number;
      startTime: number;
      hadRecentInput: boolean;
    }>;
    po.disconnect();
    let best = 0;
    let current = 0;
    let windowStart = -Infinity;
    let last = -Infinity;
    for (const e of records) {
      if (e.hadRecentInput) continue;
      if (e.startTime - last > 1000 || e.startTime - windowStart > 5000) {
        current = 0;
        windowStart = e.startTime;
      }
      current += e.value;
      last = e.startTime;
      if (current > best) best = current;
    }
    cls = best;
  } catch {
    cls = null;
  }

  return {
    url: location.href,
    title: document.title,
    cls,
    elementCount,
    defects,
    axeViolations,
    axeAvailable,
    truncated: defects.length >= MAX,
  };
}

/** Palette / type scale / spacing / layout regions from computed styles. */
export function atlarixDesignSnapshot(): DesignSnapshot {
  const els = Array.from(document.querySelectorAll("body *")).slice(0, 3000);
  const colorCount = new Map<string, number>();
  const fonts = new Set<string>();
  const sizes = new Set<string>();
  const spaces = new Set<string>();
  const bump = (k: string) => {
    if (k) colorCount.set(k, (colorCount.get(k) || 0) + 1);
  };
  for (const el of els) {
    try {
      const s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (s.color) bump(s.color);
      if (s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)") {
        bump(s.backgroundColor);
      }
      if (s.fontFamily) {
        fonts.add(s.fontFamily.split(",")[0].replace(/["']/g, "").trim());
      }
      const hasText = Array.from(el.childNodes).some(
        (n) => n.nodeType === 3 && n.textContent && n.textContent.trim(),
      );
      if (hasText && s.fontSize) sizes.add(s.fontSize + " / " + s.fontWeight);
      for (const p of [s.paddingTop, s.paddingLeft, s.marginTop, s.gap]) {
        if (p && p !== "0px" && /px$/.test(p)) spaces.add(p);
      }
    } catch {
      /* skip */
    }
  }
  const sortPx = (arr: string[]) =>
    arr.sort((a, b) => parseFloat(a) - parseFloat(b));
  const layout: string[] = [];
  for (const sel of ["header", "nav", "main", "aside", "footer", "section"]) {
    const el = document.querySelector(sel);
    if (el) {
      const r = el.getBoundingClientRect();
      layout.push(sel + ": " + Math.round(r.width) + "×" + Math.round(r.height));
    }
  }
  return {
    url: location.href,
    title: document.title,
    palette: Array.from(colorCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map((e) => ({ color: e[0], count: e[1] })),
    fontFamilies: Array.from(fonts).slice(0, 6),
    typeScale: sortPx(Array.from(sizes)).slice(0, 12),
    spacing: sortPx(Array.from(spaces)).slice(0, 12),
    layout,
  };
}
