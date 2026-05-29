import { parseChartSpec } from "./chart-spec";
import { parseGraphSpec } from "./graph-spec";

export type ArtifactTitleKind = "graph" | "markmap" | "chart";

export function inferArtifactTitle(
  kind: ArtifactTitleKind,
  raw: string,
): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  if (kind === "chart") {
    const spec = parseChartSpec(trimmed);
    return spec?.title?.trim() || undefined;
  }

  if (kind === "graph") {
    const spec = parseGraphSpec(trimmed);
    if (spec?.title?.trim()) return spec.title.trim();
    const first = spec?.nodes[0]?.name?.trim();
    return first || "Diagram";
  }

  if (kind === "markmap") {
    for (const line of trimmed.split("\n")) {
      const m = line.match(/^#\s+(.+?)\s*$/);
      if (m?.[1]) return m[1].trim();
    }
    return "Mind map";
  }

  return undefined;
}
