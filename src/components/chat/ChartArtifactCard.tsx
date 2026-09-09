import { useMemo } from "react";
import { parseChartSpec } from "@/lib/visual-artifacts/chart-spec";
import { ChartBody } from "@/lib/visual-artifacts/ChartBody";
import { inferArtifactTitle } from "@/lib/visual-artifacts/infer-title";
import { VisualArtifactCard } from "./VisualArtifactCard";
import { ArtifactStreamingOverlay } from "./ArtifactStreamingOverlay";

export function ChartArtifactCard({
  code,
  isStreaming = false,
}: {
  code: string;
  isStreaming?: boolean;
}) {
  const spec = useMemo(() => parseChartSpec(code), [code]);
  const title = useMemo(
    () =>
      inferArtifactTitle("chart", code) ??
      (spec ? "Chart" : "Chart (invalid spec)"),
    [code, spec],
  );
  const loading = isStreaming && !spec;

  return (
    <VisualArtifactCard title={title} layout="content">
      <div className="relative min-h-[120px] w-full">
        {loading ? <ArtifactStreamingOverlay label="Building chart…" /> : null}
        {spec ? (
          <ChartBody spec={spec} />
        ) : !loading ? (
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap">
            {code}
          </pre>
        ) : null}
      </div>
    </VisualArtifactCard>
  );
}
