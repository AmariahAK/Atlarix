/**
 * Turning the page-realm visual / design reports into the compact TEXT the
 * model reads — ~500 tokens where a screenshot costs thousands, and more
 * accurate than vision for structural facts.
 *
 * The measuring happens in the user's Chrome (`page-scripts/visual.ts`, run by
 * the extension); ranking, capping and wording happen here, on the desktop, so
 * the model sees one format whatever extension build answered.
 */

import type {
  DesignSnapshot,
  VisualDefect,
  VisualLintArgs,
  VisualLintRaw,
} from "./page-scripts/visual";

/** Cap findings so a pathological page can't bloat the result. */
export const MAX_DEFECTS = 25;
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

/** The args the extension passes to `atlarixVisualLint`. */
export const VISUAL_LINT_ARGS: VisualLintArgs = {
  maxDefects: MAX_DEFECTS,
  maxAxe: MAX_AXE_VIOLATIONS,
  axeRules: AXE_VISUAL_RULES,
};

export interface VisualLintReport {
  url: string;
  title: string;
  cls: number | null;
  elementCount: number;
  defects: VisualDefect[];
  axeAvailable: boolean;
  truncated: boolean;
}

const IMPACT_RANK: Record<string, number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
};

/** Merge hand-rolled + axe findings, rank by impact, cap. */
export function shapeVisualLint(raw: VisualLintRaw): VisualLintReport {
  const defects = [...(raw.defects ?? []), ...(raw.axeViolations ?? [])]
    .sort((a, b) => (IMPACT_RANK[a.impact] ?? 3) - (IMPACT_RANK[b.impact] ?? 3))
    .slice(0, MAX_DEFECTS);
  return {
    url: raw.url,
    title: raw.title,
    cls: raw.cls,
    elementCount: raw.elementCount,
    defects,
    axeAvailable: raw.axeAvailable !== false,
    truncated: raw.truncated || defects.length >= MAX_DEFECTS,
  };
}

/** Render a VisualLintReport as compact text the model reads. */
export function formatVisualLintReport(r: VisualLintReport): string {
  const clsLine =
    r.cls != null
      ? `CLS (layout shift): ${r.cls.toFixed(3)}${r.cls > 0.1 ? " — above the 0.1 'good' threshold" : " (good)"}`
      : "CLS: not measured";
  // Say so when the contrast/accessible-name half did not run, so "no defects"
  // is never read as "contrast checked and clean".
  const axeNote = r.axeAvailable
    ? ""
    : " Contrast and accessible-name checks did not run on this page.";
  if (r.defects.length === 0) {
    return `Visual lint — no defects found. ${r.elementCount} elements rendered. ${clsLine}. The page appears to render correctly.${axeNote}`;
  }
  const lines = r.defects.map(
    (d) =>
      `- [${d.impact}] ${d.rule}: ${d.message}${d.count && d.count > 1 ? ` (${d.count} nodes)` : ""}${d.target ? ` — ${d.target}` : ""}`,
  );
  return (
    `Visual lint — ${r.defects.length} defect(s)${r.truncated ? " (capped)" : ""} on ${r.url}. ${r.elementCount} elements. ${clsLine}.${axeNote}\n` +
    lines.join("\n") +
    `\nFix the cause and re-inspect with browser_inspect mode:"visual".`
  );
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
