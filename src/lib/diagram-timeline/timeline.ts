/**
 * Diagram Timeline - Timeline Module
 * 
 * Provides timeline queries with hybrid time granularity.
 * Supports simple view (Today/Week/Month/All) and drill-down to detailed intervals.
 */

import log from "electron-log";
import { db } from "../../db";
import { workspaceDiagrams } from "../../db/schema";
import { eq, and, gte, lte, desc } from "drizzle-orm";

const logger = log.scope("diagram-timeline");

export type TimeRange = "today" | "week" | "month" | "all";
export type DetailedRange = "1h" | "3h" | "6h" | "1d" | "2d" | "3d" | "1w" | "2w" | "3w" | "1m" | "3m" | "6m" | "1y";
export type GroupBy = "hour" | "day" | "week" | "month";

export interface Snapshot {
    id: number;
    appId: number;
    architecture: string;
    dependencies: string | null;
    flows: Record<string, string> | null;
    trigger: string;
    summary: string | null;
    annotation: string | null;
    filesChanged: string[] | null;
    hash: string;
    protected: boolean;
    compressed: boolean;
    createdAt: Date;
}

export interface TimelineResult {
    snapshots: Snapshot[];
    grouped: boolean;
    groupBy?: GroupBy;
    totalCount: number;
}

export interface DiffIndicators {
    architectureChanged: boolean;
    dependenciesChanged: boolean;
}

/**
 * Get the start date for a time range
 */
export function getTimeRangeStart(range: TimeRange): Date {
    const now = new Date();
    switch (range) {
        case "today":
            return new Date(now.getFullYear(), now.getMonth(), now.getDate());
        case "week":
            const weekAgo = new Date(now);
            weekAgo.setDate(weekAgo.getDate() - 7);
            return weekAgo;
        case "month":
            const monthAgo = new Date(now);
            monthAgo.setMonth(monthAgo.getMonth() - 1);
            return monthAgo;
        case "all":
        default:
            return new Date(0); // Epoch
    }
}

/**
 * Get the detailed ranges available for a simple time range
 */
export function getDetailedRanges(simpleRange: TimeRange): DetailedRange[] {
    switch (simpleRange) {
        case "today":
            return ["1h", "3h", "6h"];
        case "week":
            return ["1d", "2d", "3d"];
        case "month":
            return ["1w", "2w", "3w"];
        case "all":
            return ["1m", "3m", "6m", "1y"];
    }
}

/**
 * Determine optimal grouping based on snapshot count
 */
export function determineGrouping(count: number): GroupBy | null {
    if (count > 50) return "day";
    if (count > 20) return "hour";
    return null; // No grouping needed
}

/**
 * Get timeline snapshots for an app
 */
export async function getTimeline(
    appId: number,
    timeRange: TimeRange
): Promise<TimelineResult> {
    const startDate = getTimeRangeStart(timeRange);

    logger.log(`Getting timeline for app ${appId} from ${startDate.toISOString()}`);

    const snapshots = await db.query.workspaceDiagrams.findMany({
        where: and(
            eq(workspaceDiagrams.appId, appId),
            gte(workspaceDiagrams.createdAt, startDate)
        ),
        orderBy: [desc(workspaceDiagrams.createdAt)],
    });

    const groupBy = determineGrouping(snapshots.length);

    return {
        snapshots: snapshots as Snapshot[],
        grouped: groupBy !== null,
        groupBy: groupBy || undefined,
        totalCount: snapshots.length,
    };
}

/**
 * Get a single snapshot by ID
 */
export async function getSnapshot(snapshotId: number): Promise<Snapshot | null> {
    const snapshot = await db.query.workspaceDiagrams.findFirst({
        where: eq(workspaceDiagrams.id, snapshotId),
    });

    return snapshot as Snapshot | null;
}

/**
 * Calculate diff indicators between two snapshots
 */
export function getDiffIndicators(
    current: Snapshot,
    previous: Snapshot | null
): DiffIndicators {
    if (!previous) {
        return {
            architectureChanged: true,
            dependenciesChanged: !!current.dependencies,
        };
    }

    return {
        architectureChanged: current.hash !== previous.hash,
        dependenciesChanged: current.dependencies !== previous.dependencies,
    };
}

/**
 * Group snapshots by time period
 */
export function groupSnapshots(
    snapshots: Snapshot[],
    groupBy: GroupBy
): Map<string, Snapshot[]> {
    const groups = new Map<string, Snapshot[]>();

    for (const snapshot of snapshots) {
        const date = new Date(snapshot.createdAt);
        let key: string;

        switch (groupBy) {
            case "hour":
                key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}`;
                break;
            case "day":
                key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
                break;
            case "week":
                const weekStart = new Date(date);
                weekStart.setDate(date.getDate() - date.getDay());
                key = `${weekStart.getFullYear()}-${weekStart.getMonth()}-${weekStart.getDate()}`;
                break;
            case "month":
                key = `${date.getFullYear()}-${date.getMonth()}`;
                break;
        }

        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key)!.push(snapshot);
    }

    return groups;
}

/**
 * Get snapshots from a detailed time range within a simple range
 */
export async function getDetailedTimeline(
    appId: number,
    detailedRange: DetailedRange
): Promise<TimelineResult> {
    const now = new Date();
    let startDate: Date;

    // Parse the detailed range
    const value = parseInt(detailedRange);
    const unit = detailedRange.replace(/\d/g, "");

    switch (unit) {
        case "h":
            startDate = new Date(now.getTime() - value * 60 * 60 * 1000);
            break;
        case "d":
            startDate = new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
            break;
        case "w":
            startDate = new Date(now.getTime() - value * 7 * 24 * 60 * 60 * 1000);
            break;
        case "m":
            startDate = new Date(now);
            startDate.setMonth(startDate.getMonth() - value);
            break;
        case "y":
            startDate = new Date(now);
            startDate.setFullYear(startDate.getFullYear() - value);
            break;
        default:
            startDate = new Date(0);
    }

    const snapshots = await db.query.workspaceDiagrams.findMany({
        where: and(
            eq(workspaceDiagrams.appId, appId),
            gte(workspaceDiagrams.createdAt, startDate)
        ),
        orderBy: [desc(workspaceDiagrams.createdAt)],
    });

    return {
        snapshots: snapshots as Snapshot[],
        grouped: false,
        totalCount: snapshots.length,
    };
}
