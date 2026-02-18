/**
 * Custom edge for Blueprint flow: directional colors (red=to, blue=from, purple=both)
 * and arrow labels (>> / << / ⇄) at multiple points along the path.
 */

import { useLayoutEffect, useRef, useState } from "react";
import { getSmoothStepPath, type EdgeProps } from "@xyflow/react";

/** Fractions of path length for label positions (spread along the line) */
const LABEL_FRACTIONS = [0.25, 0.5, 0.75];

type EdgeDirection = "to" | "from" | "both";

const DIRECTION_COLORS: Record<EdgeDirection, string> = {
  to: "hsl(0, 70%, 52%)",
  from: "hsl(220, 70%, 55%)",
  both: "hsl(270, 60%, 55%)",
};

const DIRECTION_LABELS: Record<EdgeDirection, string> = {
  to: ">>",
  from: "<<",
  both: "⇄",
};

export function BlueprintEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
  markerEnd,
}: EdgeProps) {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const pathRef = useRef<SVGPathElement>(null);
  const [labelPoints, setLabelPoints] = useState<{ x: number; y: number }[]>([]);

  useLayoutEffect(() => {
    const pathEl = pathRef.current;
    if (!pathEl) return;
    const len = pathEl.getTotalLength();
    const points = LABEL_FRACTIONS.map((f) => {
      const p = pathEl.getPointAtLength(len * f);
      return { x: p.x, y: p.y };
    });
    setLabelPoints(points);
  }, [edgePath]);

  const direction: EdgeDirection = (data?.direction as EdgeDirection) ?? "to";
  const strokeColor = DIRECTION_COLORS[direction];
  const arrowLabel = DIRECTION_LABELS[direction];
  const isRteRunning = data?.isRteRunning === true;
  const inferred = data?.inferred === true;
  const pathStyle = {
    fill: "none" as const,
    strokeWidth: 2,
    stroke: strokeColor,
    strokeOpacity: 1,
    ...(isRteRunning && inferred ? { animation: "blueprint-edge-pulse 1.5s ease-in-out infinite" } : {}),
  };

  return (
    <g>
      <path
        ref={pathRef}
        id={id}
        d={edgePath}
        fill="none"
        stroke={strokeColor}
        strokeWidth={2}
        strokeOpacity={1}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ ...pathStyle, stroke: strokeColor }}
        className="react-flow__edge-path atlarix-blueprint-edge-path"
        markerEnd={markerEnd}
      />
      {labelPoints.map((pt, i) => (
        <text
          key={i}
          x={pt.x}
          y={pt.y}
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-foreground text-[10px] font-mono pointer-events-none"
          style={{ userSelect: "none" }}
        >
          {arrowLabel}
        </text>
      ))}
      {inferred && (
        <title>Inferred connection — refresh from code to confirm</title>
      )}
    </g>
  );
}
