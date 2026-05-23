import React from "react";
import type { ChartSpec } from "./chart-spec";

export function ChartBody({ spec }: { spec: ChartSpec }) {
  const max = Math.max(...spec.values, 1);

  return (
    <div className="space-y-3">
      {spec.type === "bar" ? (
        <div className="flex items-end gap-2 h-44 w-full min-h-[11rem]">
          {spec.labels.map((label, i) => {
            const v = spec.values[i] ?? 0;
            const barPx = Math.max(4, Math.round((v / max) * 160));
            return (
              <div
                key={`${label}-${i}`}
                className="flex flex-col items-center justify-end flex-1 min-w-0 h-full gap-1.5"
                title={`${label}: ${v}`}
              >
                <div
                  className="w-full max-w-[56px] rounded-t bg-primary/70 shrink-0"
                  style={{ height: barPx }}
                />
                <span className="text-[10px] text-muted-foreground truncate w-full text-center shrink-0">
                  {label}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <svg viewBox="0 0 320 120" className="w-full h-32 text-primary">
          <polyline
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            points={spec.values
              .map((v, i) => {
                const x = (i / Math.max(1, spec.values.length - 1)) * 300 + 10;
                const y = 110 - (v / max) * 90;
                return `${x},${y}`;
              })
              .join(" ")}
          />
        </svg>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {spec.labels.map((l, i) => (
          <span key={`${l}-${i}`}>
            {l}: <strong className="text-foreground">{spec.values[i]}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}
