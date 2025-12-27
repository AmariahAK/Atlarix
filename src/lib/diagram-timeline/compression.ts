/**
 * Diagram Timeline - Compression Module
 * 
 * Handles cleanup and compression of old snapshots.
 * - After 30 days: Keep 1 snapshot per week
 * - Keep at least 1 snapshot per month forever
 * - Never delete protected (annotated) snapshots
 */

import log from "electron-log";
import { db } from "../../db";
import { workspaceDiagrams } from "../../db/schema";
import { eq, and, lt, sql } from "drizzle-orm";

const logger = log.scope("diagram-timeline-compression");

/**
 * Get the date 30 days ago
 */
function getThirtyDaysAgo(): Date {
    const date = new Date();
    date.setDate(date.getDate() - 30);
    return date;
}

/**
 * Group snapshots by week
 */
function groupByWeek(snapshots: any[]): Map<string, any[]> {
    const groups = new Map<string, any[]>();

    for (const snapshot of snapshots) {
        const date = new Date(snapshot.createdAt);
        const weekStart = new Date(date);
        weekStart.setDate(date.getDate() - date.getDay());
        const key = `${weekStart.getFullYear()}-${weekStart.getMonth()}-${weekStart.getDate()}`;

        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key)!.push(snapshot);
    }

    return groups;
}

/**
 * Group snapshots by month
 */
function groupByMonth(snapshots: any[]): Map<string, any[]> {
    const groups = new Map<string, any[]>();

    for (const snapshot of snapshots) {
        const date = new Date(snapshot.createdAt);
        const key = `${date.getFullYear()}-${date.getMonth()}`;

        if (!groups.has(key)) {
            groups.set(key, []);
        }
        groups.get(key)!.push(snapshot);
    }

    return groups;
}

/**
 * Compress old snapshots for an app
 * - Keeps 1 snapshot per week for snapshots older than 30 days
 * - Keeps at least 1 snapshot per month forever
 * - Never deletes protected snapshots
 */
export async function compressOldSnapshots(appId: number): Promise<{
    deleted: number;
    kept: number;
}> {
    logger.log(`Compressing old snapshots for app ${appId}`);

    const thirtyDaysAgo = getThirtyDaysAgo();

    // Get all old snapshots (older than 30 days)
    const oldSnapshots = await db.query.workspaceDiagrams.findMany({
        where: and(
            eq(workspaceDiagrams.appId, appId),
            lt(workspaceDiagrams.createdAt, thirtyDaysAgo)
        ),
        orderBy: (diagrams, { asc }) => [asc(diagrams.createdAt)],
    });

    if (oldSnapshots.length === 0) {
        logger.log(`No old snapshots to compress for app ${appId}`);
        return { deleted: 0, kept: 0 };
    }

    // Separate protected snapshots (never delete)
    const protectedSnapshots = oldSnapshots.filter((s) => s.protected);
    const compressibleSnapshots = oldSnapshots.filter((s) => !s.protected);

    // Group by week
    const byWeek = groupByWeek(compressibleSnapshots);

    // Keep only the first snapshot of each week
    const toKeep: number[] = [];
    const toDelete: number[] = [];

    for (const [_, weekSnapshots] of byWeek) {
        if (weekSnapshots.length > 0) {
            // Keep the first snapshot of the week
            toKeep.push(weekSnapshots[0].id);
            // Mark the rest for deletion
            toDelete.push(...weekSnapshots.slice(1).map((s: any) => s.id));
        }
    }

    // Additionally, ensure at least 1 snapshot per month is kept forever
    const byMonth = groupByMonth(compressibleSnapshots);
    for (const [_, monthSnapshots] of byMonth) {
        // Make sure the first snapshot of each month is kept
        const firstOfMonth = monthSnapshots[0];
        if (firstOfMonth && toDelete.includes(firstOfMonth.id)) {
            // Move from delete to keep
            const idx = toDelete.indexOf(firstOfMonth.id);
            toDelete.splice(idx, 1);
            if (!toKeep.includes(firstOfMonth.id)) {
                toKeep.push(firstOfMonth.id);
            }
        }
    }

    // Protected snapshots are always kept
    toKeep.push(...protectedSnapshots.map((s) => s.id));

    // Delete the rest
    if (toDelete.length > 0) {
        await db
            .delete(workspaceDiagrams)
            .where(
                and(
                    eq(workspaceDiagrams.appId, appId),
                    sql`${workspaceDiagrams.id} IN (${toDelete.join(",")})`
                )
            );

        logger.log(`Deleted ${toDelete.length} old snapshots for app ${appId}`);
    }

    // Mark kept snapshots as compressed
    if (toKeep.length > 0) {
        await db
            .update(workspaceDiagrams)
            .set({ compressed: true })
            .where(
                and(
                    eq(workspaceDiagrams.appId, appId),
                    sql`${workspaceDiagrams.id} IN (${toKeep.join(",")})`
                )
            );
    }

    return {
        deleted: toDelete.length,
        kept: toKeep.length + protectedSnapshots.length,
    };
}

/**
 * Run compression for all apps
 */
export async function compressAllApps(): Promise<{
    appsProcessed: number;
    totalDeleted: number;
}> {
    logger.log("Running compression for all apps");

    // Get distinct app IDs with old snapshots
    const thirtyDaysAgo = getThirtyDaysAgo();

    const appsWithOld = await db
        .selectDistinct({ appId: workspaceDiagrams.appId })
        .from(workspaceDiagrams)
        .where(lt(workspaceDiagrams.createdAt, thirtyDaysAgo));

    let totalDeleted = 0;

    for (const { appId } of appsWithOld) {
        const result = await compressOldSnapshots(appId);
        totalDeleted += result.deleted;
    }

    logger.log(`Compression complete: ${appsWithOld.length} apps, ${totalDeleted} snapshots deleted`);

    return {
        appsProcessed: appsWithOld.length,
        totalDeleted,
    };
}
