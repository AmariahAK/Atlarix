import React from "react";
import { cn } from "@/lib/utils";

export interface TokenCircleProps {
  used: number;
  total: number;
  size?: number;
  /** Subtle pulse while context compaction / summarization is running */
  pulse?: boolean;
  /** Brief success accent after compaction completes */
  flashSuccess?: boolean;
}

export function TokenCircle({
  used,
  total,
  size = 24,
  pulse = false,
  flashSuccess = false,
}: TokenCircleProps) {
  const safeTotal = total > 0 ? total : 1;
  const pct = Math.min(Math.max(used / safeTotal, 0), 1);
  const radius = (size - 4) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct);

  const color = flashSuccess
    ? "#10b981"
    : pct >= 0.85
      ? "#ef4444"
      : pct >= 0.65
        ? "#f59e0b"
        : "#10b981";

  const cx = size / 2;
  const cy = size / 2;

  return (
    <svg
      width={size}
      height={size}
      className={cn("shrink-0 text-foreground", pulse && "animate-pulse")}
      aria-hidden
    >
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.15}
        strokeWidth={2}
      />
      <circle
        cx={cx}
        cy={cy}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{ transition: "stroke-dashoffset 0.3s ease, stroke 0.35s ease" }}
      />
    </svg>
  );
}
