/**
 * Diagram Timeline - Capture Module
 * 
 * Captures workspace diagram snapshots with deduplication and priority-based capture.
 * Part of the Diagram Timeline System for showing project evolution over time.
 */

import { createHash } from "crypto";
import log from "electron-log";
import { db } from "../../db";
import { workspaceDiagrams, apps } from "../../db/schema";
import { eq, desc } from "drizzle-orm";
import { analyzeWorkspace, generateArchitectureDiagram } from "../analysis";

const logger = log.scope("diagram-timeline-capture");

// Significant files that trigger immediate capture (no debouncing)
// Excludes lock files - they change on every npm install without structural impact
const SIGNIFICANT_FILES = [
    "package.json",
    "tsconfig.json",
    "vite.config.*",
    "next.config.*",
    "webpack.config.*",
    "*.config.js",
    "*.config.ts",
    "src/index.*",
    "src/main.*",
    "src/App.*",
];

export type CaptureT = "auto" | "ai_change" | "user_request" | "structural";

export interface CaptureRequest {
    appId: number;
    trigger: CaptureT;
    annotation?: string;
    filesChanged?: string[];
}

export interface CaptureResult {
    snapshotId: number | null;
    skipped: boolean;
    reason?: string;
}

/**
 * Generate a hash for diagram content (for deduplication)
 */
export function hashDiagram(content: string): string {
    return createHash("sha256").update(content).digest("hex").substring(0, 32);
}

/**
 * Check if a file change is significant (requires immediate capture)
 */
export function isSignificantChange(files: string[]): boolean {
    return files.some((file) => {
        const basename = file.split("/").pop() || file;
        return SIGNIFICANT_FILES.some((pattern) => {
            if (pattern.includes("*")) {
                const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
                return regex.test(basename);
            }
            return basename === pattern;
        });
    });
}

/**
 * Check if a snapshot should be captured (deduplication check)
 */
export async function shouldCaptureSnapshot(
    appId: number,
    newHash: string
): Promise<boolean> {
    const latest = await db.query.workspaceDiagrams.findFirst({
        where: eq(workspaceDiagrams.appId, appId),
        orderBy: [desc(workspaceDiagrams.createdAt)],
        columns: { hash: true },
    });

    if (!latest) return true; // First snapshot
    return latest.hash !== newHash; // Only capture if different
}

/**
 * Get the latest snapshot for an app
 */
export async function getLatestSnapshot(appId: number) {
    return db.query.workspaceDiagrams.findFirst({
        where: eq(workspaceDiagrams.appId, appId),
        orderBy: [desc(workspaceDiagrams.createdAt)],
    });
}

/**
 * Capture a new diagram snapshot
 */
export async function captureSnapshot(
    req: CaptureRequest
): Promise<CaptureResult> {
    logger.log(
        `Capturing snapshot for app ${req.appId} (trigger: ${req.trigger})`
    );

    try {
        // Get app info
        const app = await db.query.apps.findFirst({
            where: eq(apps.id, req.appId),
            columns: { path: true, name: true },
        });

        if (!app) {
            logger.error(`App not found: ${req.appId}`);
            return { snapshotId: null, skipped: true, reason: "App not found" };
        }

        // Generate architecture diagram (two-step: analyze then generate)
        const analysis = await analyzeWorkspace(app.path);
        if (!analysis || analysis.files.length === 0) {
            logger.warn(`No analysis generated for app ${req.appId}`);
            return { snapshotId: null, skipped: true, reason: "No workspace analysis" };
        }

        const diagram = generateArchitectureDiagram(analysis);
        if (!diagram) {
            logger.warn(`No diagram generated for app ${req.appId}`);
            return { snapshotId: null, skipped: true, reason: "No diagram generated" };
        }

        // Hash the diagram content
        const diagramHash = hashDiagram(diagram);

        // Check for duplicates
        const shouldCapture = await shouldCaptureSnapshot(req.appId, diagramHash);
        if (!shouldCapture) {
            logger.log(`Skipping duplicate snapshot for app ${req.appId}`);
            return { snapshotId: null, skipped: true, reason: "Duplicate (no changes)" };
        }

        // Determine if this snapshot should be protected (user annotation = protected)
        const isProtected = !!req.annotation;

        // Insert the snapshot
        const [snapshot] = await db
            .insert(workspaceDiagrams)
            .values({
                appId: req.appId,
                architecture: diagram,
                dependencies: null, // TODO: Generate on package.json change
                flows: null, // User-created, not auto-generated
                trigger: req.trigger,
                summary: null, // TODO: AI-generated summary
                annotation: req.annotation || null,
                filesChanged: req.filesChanged || null,
                hash: diagramHash,
                protected: isProtected ? 1 : 0,
                compressed: false,
                createdAt: new Date(),
            } as any)
            .returning();

        logger.log(`Created snapshot ${snapshot.id} for app ${req.appId}`);

        return { snapshotId: snapshot.id, skipped: false };
    } catch (error) {
        logger.error(`Error capturing snapshot: ${error}`);
        return { snapshotId: null, skipped: true, reason: String(error) };
    }
}

/**
 * Capture first snapshot for a newly imported workspace
 */
export async function captureInitialSnapshot(appId: number): Promise<number | null> {
    const result = await captureSnapshot({
        appId,
        trigger: "user_request",
        annotation: "Initial import",
    });
    return result.snapshotId;
}

// Debounce state for AI changes
const pendingCaptures = new Map<number, NodeJS.Timeout>();
const pendingFiles = new Map<number, string[]>();

/**
 * Queue a capture (with debouncing for rapid AI changes)
 */
export function queueCapture(
    appId: number,
    filesChanged: string[],
    debounceMs: number = 8 * 60 * 1000 // 8 minutes (was 5) - reduce diagram churn
): void {
    // Check if significant file changed (bypass debounce)
    if (isSignificantChange(filesChanged)) {
        logger.log(`Significant file changed, capturing immediately for app ${appId}`);
        captureSnapshot({
            appId,
            trigger: "structural",
            filesChanged,
        });
        return;
    }

    // Accumulate files
    const existing = pendingFiles.get(appId) || [];
    pendingFiles.set(appId, [...new Set([...existing, ...filesChanged])]);

    // Clear existing timeout
    const existingTimeout = pendingCaptures.get(appId);
    if (existingTimeout) {
        clearTimeout(existingTimeout);
    }

    // Set new timeout
    const timeout = setTimeout(async () => {
        const files = pendingFiles.get(appId) || [];

        // Only capture if >= 5 files changed (was 3 - reduce churn from small edits)
        if (files.length >= 5) {
            logger.log(`Debounce complete, capturing snapshot for app ${appId} (${files.length} files)`);
            await captureSnapshot({
                appId,
                trigger: "ai_change",
                filesChanged: files,
            });
        } else {
            logger.log(`Not enough files changed (${files.length} < 5), skipping capture for app ${appId}`);
        }

        // Cleanup
        pendingCaptures.delete(appId);
        pendingFiles.delete(appId);
    }, debounceMs);

    pendingCaptures.set(appId, timeout);
}

/**
 * Flush all pending captures (call on app close)
 */
export async function flushPendingCaptures(): Promise<void> {
    logger.log(`Flushing ${pendingCaptures.size} pending captures`);

    for (const [appId, timeout] of pendingCaptures) {
        clearTimeout(timeout);
        const files = pendingFiles.get(appId) || [];

        if (files.length >= 5) {
            await captureSnapshot({
                appId,
                trigger: "ai_change",
                filesChanged: files,
            });
        }
    }

    pendingCaptures.clear();
    pendingFiles.clear();
}
