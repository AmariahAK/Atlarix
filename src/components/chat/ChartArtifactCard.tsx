import React, { useMemo } from "react";
import { parseChartSpec } from "@/lib/visual-artifacts/chart-spec";
import { ChartBody } from "@/lib/visual-artifacts/ChartBody";
import { inferArtifactTitle } from "@/lib/visual-artifacts/infer-title";
import { VisualArtifactCard } from "./VisualArtifactCard";

export function ChartArtifactCard({ code }: { code: string }) {
  const spec = useMemo(() => parseChartSpec(code), [code]);
  const title = useMemo(
    () => inferArtifactTitle("chart", code) ?? (spec ? "Chart" : "Chart (invalid spec)"),
    [code, spec],
  );

  return (
    <VisualArtifactCard title={title} layout="content">
      {spec ? (
        <ChartBody spec={spec} />
      ) : (
        <pre className="text-xs text-muted-foreground whitespace-pre-wrap">{code}</pre>
      )}
    </VisualArtifactCard>
  );
}
