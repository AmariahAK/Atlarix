/**
 * Auto-Cleanup Jobs
 * Runs daily to clean old sessions and summarize modifications
 */

import { db } from "./index";
import { chatSessions, workspaceModifications, cleanupLog } from "./schema";
import { lt, and, eq, inArray } from "drizzle-orm";
import log from "electron-log";
import { schedule } from "node-cron";

const logger = log.scope("cleanup-jobs");

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Delete workspace chat sessions not updated in 30 days.
 */
async function cleanupOldSessions(): Promise<number> {
    const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS_MS);

    try {
        const result = await db
            .delete(chatSessions)
            .where(lt(chatSessions.updatedAt, thirtyDaysAgo))
            .run();

        const deleted = result.changes || 0;
        if (deleted > 0) {
            logger.info(`Deleted ${deleted} old workspace sessions`);
        }
        return deleted;
    } catch (error) {
        logger.error(`Failed to cleanup old sessions: ${error}`);
        return 0;
    }
}

/**
 * Generate AI summary for a list of modifications
 */
async function generateAISummary(modifications: any[]): Promise<string> {
    // TODO: Integrate with actual AI model for summarization
    // For now, create a simple summary

    const summary = modifications.map((m, i) =>
        `${i + 1}. Task: ${m.todoReference || 'N/A'}\n   Files: ${m.filesModified ? JSON.parse(m.filesModified).join(', ') : 'N/A'
        }\n   ${m.changesDescription || 'No description'}`
    ).join('\n\n');

    return `Summary of ${modifications.length} modifications:\n\n${summary}`;
}

/**
 * Summarize old modifications for a specific workspace
 */
async function summarizeWorkspaceModifications(workspacePath: string): Promise<boolean> {
    const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS_MS);

    try {
        // Get old modifications for this workspace
        const oldMods = await db
            .select()
            .from(workspaceModifications)
            .where(
                and(
                    eq(workspaceModifications.workspacePath, workspacePath),
                    lt(workspaceModifications.lastUsedAt, thirtyDaysAgo),
                    eq(workspaceModifications.isSummary, false)
                )
            )
            .all();

        if (oldMods.length === 0) {
            return false;
        }

        logger.info(`Summarizing ${oldMods.length} modifications for: ${workspacePath}`);

        // Generate AI summary
        const aiSummary = await generateAISummary(oldMods);

        // Calculate period
        const dates = oldMods.map(m => m.createdAt.getTime());
        const periodStart = new Date(Math.min(...dates));
        const periodEnd = new Date(Math.max(...dates));
        const period = `${periodStart.toLocaleDateString()} to ${periodEnd.toLocaleDateString()}`;

        // Create summary record
        await db.insert(workspaceModifications).values({
            workspacePath,
            createdAt: new Date(),
            lastUsedAt: new Date(),
            isSummary: true,
            summaryOfPeriod: period,
            aiSummary,
            todoReference: null,
            filesModified: null,
            changesDescription: null,
        });

        // Delete old individual modifications
        const idsToDelete = oldMods.map(m => m.id);
        await db
            .delete(workspaceModifications)
            .where(inArray(workspaceModifications.id, idsToDelete))
            .run();

        logger.info(`Created summary and deleted ${oldMods.length} old modifications`);
        return true;
    } catch (error) {
        logger.error(`Failed to summarize modifications for ${workspacePath}: ${error}`);
        return false;
    }
}

/**
 * Summarize modifications for all workspaces
 */
async function summarizeAllModifications(): Promise<number> {
    try {
        // Get all unique workspace paths
        const workspaces = await db
            .selectDistinct({ path: workspaceModifications.workspacePath })
            .from(workspaceModifications)
            .where(eq(workspaceModifications.isSummary, false))
            .all();

        let summarizedCount = 0;

        for (const workspace of workspaces) {
            const summarized = await summarizeWorkspaceModifications(workspace.path);
            if (summarized) {
                summarizedCount++;
            }
        }

        if (summarizedCount > 0) {
            logger.info(`Summarized modifications for ${summarizedCount} workspaces`);
        }
        return summarizedCount;
    } catch (error) {
        logger.error(`Failed to summarize all modifications: ${error}`);
        return 0;
    }
}

/**
 * Run daily cleanup job
 */
export async function runDailyCleanup(): Promise<void> {
    const startTime = Date.now();

    // Clean old sessions
    const sessionsDeleted = await cleanupOldSessions();

    // Summarize old modifications
    const modificationsSummarized = await summarizeAllModifications();

    // Log cleanup
    try {
        await db.insert(cleanupLog).values({
            cleanupDate: new Date(),
            sessionsDeleted,
            modificationsSummarized,
        });
    } catch (error) {
        logger.error(`Failed to log cleanup: ${error}`);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    if (sessionsDeleted > 0 || modificationsSummarized > 0) {
        logger.info(
            `Cleanup job completed in ${duration}s: ${sessionsDeleted} sessions, ${modificationsSummarized} workspaces`,
        );
    }
}

/**
 * Schedule daily cleanup job (runs at 3 AM)
 */
export function scheduleCleanupJobs(): void {
    // Run daily at 3 AM
    schedule("0 3 * * *", async () => {
        await runDailyCleanup();
    });

    // Optional: Run on app start if last cleanup was more than 24 hours ago
    checkAndRunStartupCleanup();
}

/**
 * Check if cleanup needs to run on app startup
 */
async function checkAndRunStartupCleanup(): Promise<void> {
    try {
        const lastCleanup = await db
            .select()
            .from(cleanupLog)
            .orderBy(cleanupLog.cleanupDate)
            .limit(1)
            .get();

        if (!lastCleanup) {
            await runDailyCleanup();
            return;
        }

        const hoursSinceLastCleanup = (Date.now() - lastCleanup.cleanupDate.getTime()) / (1000 * 60 * 60);

        if (hoursSinceLastCleanup > 24) {
            await runDailyCleanup();
        }
    } catch (error) {
        logger.error(`Failed to check startup cleanup: ${error}`);
    }
}
