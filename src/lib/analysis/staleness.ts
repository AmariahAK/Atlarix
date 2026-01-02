/**
 * Diagram Staleness Detection
 * ===========================
 * Detect when diagrams are outdated due to workspace changes.
 */

import { generateFingerprint, compareFingerprints, type WorkspaceFingerprint } from './fingerprint';
import log from 'electron-log';

const logger = log.scope('diagram-staleness');

export interface StalenessCheck {
    isStale: boolean;
    severity: 'none' | 'minor' | 'moderate' | 'major';
    reason: string;
    changes: {
        filesAdded: number;
        filesRemoved: number;
        fileCountChange: number;
        percentChange: number;
    };
    recommendation: 'keep' | 'suggest-refresh' | 'force-refresh';
}

/**
 * Check if a diagram is stale compared to current workspace state.
 */
export async function checkDiagramStaleness(
    storedFingerprint: WorkspaceFingerprint | null,
    storedFileCount: number | null,
    workspacePath: string
): Promise<StalenessCheck> {
    logger.info(`Checking staleness for workspace: ${workspacePath}`);

    // Get current workspace state
    const currentFingerprint = await generateFingerprint(workspacePath);

    // Quick check: no stored fingerprint = first diagram, no staleness
    if (!storedFingerprint) {
        // But if we have file count and it's different, use that
        if (storedFileCount !== null) {
            const fileCountChange = currentFingerprint.fileCount - storedFileCount;
            const percentChange = Math.abs(fileCountChange) / Math.max(storedFileCount, 1) * 100;

            return determineSeverity(fileCountChange, percentChange, storedFileCount, currentFingerprint.fileCount);
        }

        return {
            isStale: false,
            severity: 'none',
            reason: 'No previous fingerprint to compare',
            changes: { filesAdded: 0, filesRemoved: 0, fileCountChange: 0, percentChange: 0 },
            recommendation: 'keep',
        };
    }

    // Compare fingerprints
    const comparison = compareFingerprints(storedFingerprint, currentFingerprint);

    // Quick check: hash match = no changes
    if (!comparison.hasHashChanged) {
        return {
            isStale: false,
            severity: 'none',
            reason: 'No changes detected',
            changes: {
                filesAdded: 0,
                filesRemoved: 0,
                fileCountChange: 0,
                percentChange: 0
            },
            recommendation: 'keep',
        };
    }

    const fileCountChange = currentFingerprint.fileCount - storedFingerprint.fileCount;

    return determineSeverity(
        fileCountChange,
        comparison.percentChange,
        storedFingerprint.fileCount,
        currentFingerprint.fileCount
    );
}

/**
 * Determine staleness severity based on file changes.
 */
function determineSeverity(
    fileCountChange: number,
    percentChange: number,
    oldFileCount: number,
    newFileCount: number
): StalenessCheck {
    const filesAdded = Math.max(0, fileCountChange);
    const filesRemoved = Math.abs(Math.min(0, fileCountChange));

    let severity: StalenessCheck['severity'];
    let recommendation: StalenessCheck['recommendation'];
    let reason: string;

    // Special case: empty → populated (major change)
    if (oldFileCount === 0 && newFileCount > 5) {
        return {
            isStale: true,
            severity: 'major',
            reason: `Workspace populated (0 → ${newFileCount} files)`,
            changes: { filesAdded, filesRemoved, fileCountChange, percentChange },
            recommendation: 'force-refresh',
        };
    }

    // Special case: populated → nearly empty (major change)
    if (oldFileCount > 10 && newFileCount < 5) {
        return {
            isStale: true,
            severity: 'major',
            reason: `Workspace cleared (${oldFileCount} → ${newFileCount} files)`,
            changes: { filesAdded, filesRemoved, fileCountChange, percentChange },
            recommendation: 'force-refresh',
        };
    }

    // Normal cases based on percentage change
    if (percentChange < 10) {
        // <10% change = minor
        severity = 'minor';
        recommendation = 'keep';
        reason = `Minor changes: ${filesAdded} added, ${filesRemoved} removed`;
    } else if (percentChange < 30) {
        // 10-30% change = moderate
        severity = 'moderate';
        recommendation = 'suggest-refresh';
        reason = `Moderate changes: ${filesAdded} added, ${filesRemoved} removed (${percentChange.toFixed(0)}%)`;
    } else {
        // >30% change = major
        severity = 'major';
        recommendation = 'force-refresh';
        reason = `Major changes: ${filesAdded} added, ${filesRemoved} removed (${percentChange.toFixed(0)}%)`;
    }

    return {
        isStale: percentChange > 5, // Consider stale if >5% change
        severity,
        reason,
        changes: { filesAdded, filesRemoved, fileCountChange, percentChange },
        recommendation,
    };
}
