/**
 * Diagram Timeline - IPC Handlers
 * 
 * Handles IPC communication for diagram timeline features.
 */

import { ipcMain } from "electron";
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
            return getDetailedTimeline(req.appId, req.detailedRange);
        }
    );

    // Get single snapshot
    ipcMain.handle("diagram:get-snapshot", async (_, snapshotId: number) => {
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
        return compressOldSnapshots(appId);
    });

    // Compress all apps
    ipcMain.handle("diagram:compress-all", async () => {
        return compressAllApps();
    });

    // Queue capture (for AI file changes, debounced)
    ipcMain.handle(
        "diagram:queue-capture",
        async (_, req: { appId: number; filesChanged: string[] }) => {
            queueCapture(req.appId, req.filesChanged);
            return { success: true };
        }
    );

    // Flush pending captures (call on app close)
    ipcMain.handle("diagram:flush-pending", async () => {
        await flushPendingCaptures();
        return { success: true };
    });

    // Capture initial snapshot for a new workspace
    ipcMain.handle("diagram:capture-initial", async (_, appId: number) => {
        const snapshotId = await captureInitialSnapshot(appId);
        return { snapshotId };
    });
}
