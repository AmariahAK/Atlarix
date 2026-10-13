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
      // A heading's inline code/bold is markdown; the card title is text
      // ("Add `--top N` CLI" showed its backticks, QA #23).
      if (m?.[1])
        return m[1]
          .replace(/`([^`]*)`/g, "$1")
          .replace(/(\*\*|__)(.+?)\1/g, "$2")
          .trim();
    }
    return "Mind map";
  }

  return undefined;
}
