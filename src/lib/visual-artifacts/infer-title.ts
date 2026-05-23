import { parseChartSpec } from "./chart-spec";

export type ArtifactTitleKind = "mermaid" | "markmap" | "chart";

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

  if (kind === "markmap") {
    for (const line of trimmed.split("\n")) {
      const m = line.match(/^#\s+(.+?)\s*$/);
      if (m?.[1]) return m[1].trim();
    }
    return "Mind map";
  }

  if (kind === "mermaid") {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("%%")) continue;

      const ganttTitle = t.match(/^title\s+(.+)$/i);
      if (ganttTitle?.[1]) return ganttTitle[1].trim();
    }

    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("%%")) continue;

      const bracketLabel = t.match(/\["([^"]+)"\]|\['([^']+)'\]/);
      if (bracketLabel?.[1] || bracketLabel?.[2]) {
        return (bracketLabel[1] ?? bracketLabel[2] ?? "").trim();
      }

      const parenLabel = t.match(/\(([^)]+)\)/);
      if (parenLabel?.[1] && !parenLabel[1].includes("-->")) {
        return parenLabel[1].trim();
      }

      break;
    }
    return "Diagram";
  }

  return undefined;
}
