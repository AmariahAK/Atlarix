/**
 * Diagram Timeline - IPC Handlers
 * 
 * Handles IPC communication for diagram timeline features.
 */

import { ipcMain } from "electron";
import log from "electron-log";
import {
    captureSnapshot,
    captureInitialSnapshot,
    queueCapture,
    flushPendingCaptures,
    getTimeline,
    getDetailedTimeline,
    getSnapshot,
    compressOldSnapshots,
    compressAllApps,
    type TimeRange,
    type DetailedRange,
    type CaptureT,
} from "../../lib/diagram-timeline";
import { db } from "../../db";
import { workspaceDiagrams } from "../../db/schema";
import { eq } from "drizzle-orm";

const logger = log.scope("diagram-timeline-handlers");

export function registerDiagramTimelineHandlers() {
    // Capture a new snapshot
    ipcMain.handle(
        "diagram:capture-snapshot",
        async (
            _,
            req: {
                appId: number;
                trigger?: CaptureT;
                annotation?: string;
                filesChanged?: string[];
            }
        ) => {
            logger.log(`IPC: diagram:capture-snapshot for app ${req.appId}`);
            const result = await captureSnapshot({
                appId: req.appId,
                trigger: req.trigger || "user_request",
                annotation: req.annotation,
                filesChanged: req.filesChanged,
            });
            return result;
        }
    );

    // Get timeline for an app
    ipcMain.handle(
        "diagram:get-timeline",
        async (
            _,
            req: {
                appId: number;
                timeRange: TimeRange;
            }
        ) => {
            logger.log(`IPC: diagram:get-timeline for app ${req.appId} (${req.timeRange})`);
            return getTimeline(req.appId, req.timeRange);
        }
    );

    // Get detailed timeline
    ipcMain.handle(
        "diagram:get-detailed-timeline",
        async (
            _,
            req: {
                appId: number;
                detailedRange: DetailedRange;
            }
        ) => {
            logger.log(`IPC: diagram:get-detailed-timeline for app ${req.appId} (${req.detailedRange})`);
            return getDetailedTimeline(req.appId, req.detailedRange);
        }
    );

    // Get single snapshot
    ipcMain.handle("diagram:get-snapshot", async (_, snapshotId: number) => {
        logger.log(`IPC: diagram:get-snapshot ${snapshotId}`);
        return getSnapshot(snapshotId);
    });

    // Annotate a snapshot
    ipcMain.handle(
        "diagram:annotate-snapshot",
        async (
            _,
            req: {
                snapshotId: number;
                annotation: string;
            }
        ) => {
            logger.log(`IPC: diagram:annotate-snapshot ${req.snapshotId}`);

            // Update the snapshot with annotation and mark as protected
            await db
                .update(workspaceDiagrams)
                .set({
                    annotation: req.annotation,
                    protected: true,
                })
                .where(eq(workspaceDiagrams.id, req.snapshotId));

            return { success: true };
        }
    );

    // Delete a snapshot (only if not protected)
    ipcMain.handle("diagram:delete-snapshot", async (_, snapshotId: number) => {
        logger.log(`IPC: diagram:delete-snapshot ${snapshotId}`);

        // Check if protected
        const snapshot = await db.query.workspaceDiagrams.findFirst({
            where: eq(workspaceDiagrams.id, snapshotId),
            columns: { protected: true },
        });

        if (snapshot?.protected) {
            return { success: false, reason: "Cannot delete protected snapshot" };
        }

        await db
            .delete(workspaceDiagrams)
            .where(eq(workspaceDiagrams.id, snapshotId));

        return { success: true };
    });

    // Compress old snapshots for an app
    ipcMain.handle("diagram:compress-old", async (_, appId: number) => {
        logger.log(`IPC: diagram:compress-old for app ${appId}`);
        return compressOldSnapshots(appId);
    });

    // Compress all apps
    ipcMain.handle("diagram:compress-all", async () => {
        logger.log("IPC: diagram:compress-all");
        return compressAllApps();
    });

    // Queue capture (for AI file changes, debounced)
    ipcMain.handle(
        "diagram:queue-capture",
        async (_, req: { appId: number; filesChanged: string[] }) => {
            logger.log(`IPC: diagram:queue-capture for app ${req.appId}`);
            queueCapture(req.appId, req.filesChanged);
            return { success: true };
        }
    );

    // Flush pending captures (call on app close)
    ipcMain.handle("diagram:flush-pending", async () => {
        logger.log("IPC: diagram:flush-pending");
        await flushPendingCaptures();
        return { success: true };
    });

    // Capture initial snapshot for a new workspace
    ipcMain.handle("diagram:capture-initial", async (_, appId: number) => {
        logger.log(`IPC: diagram:capture-initial for app ${appId}`);
        const snapshotId = await captureInitialSnapshot(appId);
        return { snapshotId };
    });
}
