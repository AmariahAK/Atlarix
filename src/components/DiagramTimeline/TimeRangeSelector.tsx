/**
 * TimeRangeSelector Component
 * 
 * Provides hybrid time granularity:
 * - Simple view: Today | This Week | This Month | All Time
 * - Drill-down: Click bucket to see detailed intervals
 */

import { useState } from "react";
import { Button } from "../ui/button";
import { cn } from "@/lib/utils";

export type TimeRange = "today" | "week" | "month" | "all";
export type DetailedRange = "1h" | "3h" | "6h" | "1d" | "2d" | "3d" | "1w" | "2w" | "3w" | "1m" | "3m" | "6m" | "1y";

interface TimeRangeSelectorProps {
    selectedRange: TimeRange;
    selectedDetailedRange?: DetailedRange;
    onRangeChange: (range: TimeRange) => void;
    onDetailedRangeChange?: (range: DetailedRange) => void;
    className?: string;
}

const SIMPLE_RANGES: { key: TimeRange; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "week", label: "This Week" },
    { key: "month", label: "This Month" },
    { key: "all", label: "All Time" },
];

const DETAILED_RANGES: Record<TimeRange, { key: DetailedRange; label: string }[]> = {
    today: [
        { key: "1h", label: "1H" },
        { key: "3h", label: "3H" },
        { key: "6h", label: "6H" },
    ],
    week: [
        { key: "1d", label: "1D" },
        { key: "2d", label: "2D" },
        { key: "3d", label: "3D" },
    ],
    month: [
        { key: "1w", label: "1W" },
        { key: "2w", label: "2W" },
        { key: "3w", label: "3W" },
    ],
    all: [
        { key: "1m", label: "1M" },
        { key: "3m", label: "3M" },
        { key: "6m", label: "6M" },
        { key: "1y", label: "1Y" },
    ],
};

export function TimeRangeSelector({
    selectedRange,
    selectedDetailedRange,
    onRangeChange,
    onDetailedRangeChange,
    className,
}: TimeRangeSelectorProps) {
    const [showDetailed, setShowDetailed] = useState(false);

    const handleRangeClick = (range: TimeRange) => {
        if (range === selectedRange) {
            // Toggle drill-down view
            setShowDetailed(!showDetailed);
        } else {
            onRangeChange(range);
            setShowDetailed(false);
        }
    };

    const handleDetailedClick = (range: DetailedRange) => {
        onDetailedRangeChange?.(range);
    };

    return (
        <div className={cn("space-y-2", className)}>
            {/* Simple Range Selector */}
            <div className="flex gap-1 p-1 bg-muted/50 rounded-lg">
                {SIMPLE_RANGES.map(({ key, label }) => (
                    <Button
                        key={key}
                        variant={selectedRange === key ? "default" : "ghost"}
                        size="sm"
                        onClick={() => handleRangeClick(key)}
                        className={cn(
                            "flex-1 text-xs",
                            selectedRange === key && "bg-primary text-primary-foreground"
                        )}
                    >
                        {label}
                    </Button>
                ))}
            </div>

            {/* Detailed Range Selector (appears on drill-down) */}
            {showDetailed && (
                <div className="flex gap-1 p-1 bg-muted/30 rounded-lg animate-in fade-in slide-in-from-top-2">
                    {DETAILED_RANGES[selectedRange].map(({ key, label }) => (
                        <Button
                            key={key}
                            variant={selectedDetailedRange === key ? "secondary" : "ghost"}
                            size="sm"
                            onClick={() => handleDetailedClick(key)}
                            className="flex-1 text-xs"
                        >
                            {label}
                        </Button>
                    ))}
                </div>
            )}
        </div>
    );
}
