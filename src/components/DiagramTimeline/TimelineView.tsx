/**
 * TimelineView Component
 * 
 * Main component for the Diagram Timeline feature.
 * Displays a visual timeline with dots, time range selector, and snapshot cards.
 */

import { useState, useEffect, useMemo } from "react";
import { TimeRangeSelector, type TimeRange, type DetailedRange } from "./TimeRangeSelector";
import { TimelineDot } from "./TimelineDot";
import { SnapshotCard } from "./SnapshotCard";
import { Button } from "../ui/button";
import { Camera, RefreshCw, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface Snapshot {
    id: number;
    appId: number;
    architecture: string;
    dependencies: string | null;
    flows: Record<string, string> | null;
    trigger: "auto" | "ai_change" | "user_request" | "structural";
    summary: string | null;
    annotation: string | null;
    filesChanged: string[] | null;
    hash: string;
    protected: boolean;
    compressed: boolean;
    createdAt: Date;
}

interface TimelineViewProps {
    appId: number;
    onSnapshotSelect?: (snapshot: Snapshot) => void;
    className?: string;
}

export function TimelineView({
    appId,
    onSnapshotSelect,
    className,
}: TimelineViewProps) {
    const [timeRange, setTimeRange] = useState<TimeRange>("week");
    const [detailedRange, setDetailedRange] = useState<DetailedRange | undefined>();
    const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
    const [selectedSnapshotId, setSelectedSnapshotId] = useState<number | null>(null);
    const [loading, setLoading] = useState(false);
    const [capturing, setCapturing] = useState(false);

    // Fetch timeline data
    const fetchTimeline = async () => {
        setLoading(true);
        try {
            if (!window.electron?.ipcRenderer) return;
            const result = await window.electron.ipcRenderer.invoke(
                detailedRange ? "diagram:get-detailed-timeline" : "diagram:get-timeline",
                detailedRange
                    ? { appId, detailedRange }
                    : { appId, timeRange }
            );
            setSnapshots(((result as { snapshots?: Snapshot[] })?.snapshots) ?? []);
        } catch (error) {
            console.error("Failed to fetch timeline:", error);
            setSnapshots([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchTimeline();
    }, [appId, timeRange, detailedRange]);

    // Calculate diff indicators for each snapshot
    const snapshotsWithDiff = useMemo(() => {
        return snapshots.map((snapshot, index) => {
            const previous = snapshots[index + 1]; // Older snapshot
            return {
                ...snapshot,
                architectureChanged: !previous || snapshot.hash !== previous.hash,
                dependenciesChanged: !previous || snapshot.dependencies !== previous.dependencies,
            };
        });
    }, [snapshots]);

    // Calculate position on timeline (0-100%)
    const getTimelinePosition = (createdAt: Date) => {
        if (snapshots.length <= 1) return 50;

        const dates = snapshots.map(s => new Date(s.createdAt).getTime());
        const min = Math.min(...dates);
        const max = Math.max(...dates);
        const range = max - min;

        if (range === 0) return 50;

        const current = new Date(createdAt).getTime();
        return ((current - min) / range) * 100;
    };

    // Handle manual snapshot capture
    const handleCaptureSnapshot = async () => {
        setCapturing(true);
        try {
            const annotation = window.prompt("Add a note for this snapshot (optional):");
            await window.electron?.ipcRenderer.invoke("diagram:capture-snapshot", {
                appId,
                trigger: "user_request",
                annotation: annotation || undefined,
            });
            await fetchTimeline();
        } catch (error) {
            console.error("Failed to capture snapshot:", error);
        } finally {
            setCapturing(false);
        }
    };

    // Handle snapshot selection
    const handleSnapshotClick = (snapshot: Snapshot) => {
        setSelectedSnapshotId(snapshot.id);
        onSnapshotSelect?.(snapshot);
    };

    // Handle delete
    const handleDelete = async (snapshotId: number) => {
        if (!window.confirm("Delete this snapshot?")) return;

        try {
            await window.electron?.ipcRenderer.invoke("diagram:delete-snapshot", snapshotId);
            await fetchTimeline();
            if (selectedSnapshotId === snapshotId) {
                setSelectedSnapshotId(null);
            }
        } catch (error) {
            console.error("Failed to delete snapshot:", error);
        }
    };

    // Handle annotate
    const handleAnnotate = async (snapshotId: number) => {
        const annotation = window.prompt("Add annotation:");
        if (!annotation) return;

        try {
            await window.electron?.ipcRenderer.invoke("diagram:annotate-snapshot", {
                snapshotId,
                annotation,
            });
            await fetchTimeline();
        } catch (error) {
            console.error("Failed to annotate snapshot:", error);
        }
    };

    const selectedSnapshot = snapshots.find(s => s.id === selectedSnapshotId);

    return (
        <div className={cn("flex flex-col h-full", className)}>
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b">
                <h3 className="font-semibold">Project Timeline</h3>
                <div className="flex items-center gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={fetchTimeline}
                        disabled={loading}
                    >
                        <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
                    </Button>
                    <Button
                        variant="default"
                        size="sm"
                        onClick={handleCaptureSnapshot}
                        disabled={capturing}
                    >
                        {capturing ? (
                            <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                        ) : (
                            <Camera className="w-4 h-4 mr-1" />
                        )}
                        Snapshot Now
                    </Button>
                </div>
            </div>

            {/* Time Range Selector */}
            <div className="p-4 border-b">
                <TimeRangeSelector
                    selectedRange={timeRange}
                    selectedDetailedRange={detailedRange}
                    onRangeChange={(range) => {
                        setTimeRange(range);
                        setDetailedRange(undefined);
                    }}
                    onDetailedRangeChange={setDetailedRange}
                />
            </div>

            {/* Visual Timeline Bar */}
            {snapshots.length > 0 && (
                <div className="px-4 py-6 border-b">
                    <div className="relative h-4 bg-muted rounded-full">
                        {snapshotsWithDiff.map((snapshot) => (
                            <TimelineDot
                                key={snapshot.id}
                                id={snapshot.id}
                                createdAt={snapshot.createdAt}
                                architectureChanged={snapshot.architectureChanged}
                                dependenciesChanged={snapshot.dependenciesChanged}
                                annotation={snapshot.annotation}
                                isProtected={snapshot.protected}
                                isSelected={selectedSnapshotId === snapshot.id}
                                position={getTimelinePosition(snapshot.createdAt)}
                                onClick={() => handleSnapshotClick(snapshot)}
                            />
                        ))}
                    </div>
                    <div className="flex justify-between mt-1 text-xs text-muted-foreground">
                        <span>Oldest</span>
                        <span>{snapshots.length} snapshots</span>
                        <span>Latest</span>
                    </div>
                </div>
            )}

            {/* Snapshot List or Details */}
            <div className="flex-1 overflow-auto p-4">
                {loading ? (
                    <div className="flex items-center justify-center h-32">
                        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                    </div>
                ) : snapshots.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-32 text-center">
                        <Camera className="w-8 h-8 text-muted-foreground mb-2" />
                        <p className="text-muted-foreground">No snapshots yet</p>
                        <p className="text-xs text-muted-foreground">
                            Click "Snapshot Now" to capture the current state
                        </p>
                    </div>
                ) : selectedSnapshot ? (
                    <SnapshotCard
                        {...selectedSnapshot}
                        isProtected={selectedSnapshot.protected}
                        onView={() => onSnapshotSelect?.(selectedSnapshot)}
                        onAnnotate={() => handleAnnotate(selectedSnapshot.id)}
                        onDelete={() => handleDelete(selectedSnapshot.id)}
                    />
                ) : (
                    <div className="grid gap-3">
                        {snapshotsWithDiff.slice(0, 5).map((snapshot) => (
                            <SnapshotCard
                                key={snapshot.id}
                                {...snapshot}
                                isProtected={snapshot.protected}
                                onView={() => handleSnapshotClick(snapshot)}
                                onAnnotate={() => handleAnnotate(snapshot.id)}
                                onDelete={() => handleDelete(snapshot.id)}
                            />
                        ))}
                        {snapshots.length > 5 && (
                            <p className="text-center text-sm text-muted-foreground">
                                +{snapshots.length - 5} more snapshots
                            </p>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
