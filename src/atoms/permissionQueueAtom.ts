/**
 * Permission Queue Atom
 * =====================
 * Tracks operation status for the permission queue panel.
 * Provides clear status progression: pending → queued → running → completed/failed
 */

import { atom } from "jotai";

export type OperationStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed';

export interface QueuedOperation {
    id: string;
    operation: 'run_command' | 'write_file' | 'edit_file' | 'delete_file' | 'rename_file' | 'write_multiple_files' | 'batch_plan' | 'revert_project_snapshot' | 'unknown';
    command?: string;
    path?: string;
    content?: string;       // File content for write_file
    oldContent?: string;    // Original content for diff view
    description?: string;   // AI-generated change summary
    preview?: string;
    /** For batch_plan: title and summary */
    batchPlanTitle?: string;
    batchPlanSummary?: string;
    batchPlanOperationsCount?: number;
    status: OperationStatus;
    progress?: number;      // 0-100 for running commands
    duration?: number;      // ms
    error?: string;
    isRecovering?: boolean; // AI is analyzing this failure
    isDangerous?: boolean;  // Command is risky (rm -rf, sudo, etc.)
    dangerExplanation?: string;  // Plain-English risk explanation
    systemScope?: boolean;  // Changes something OUTSIDE the project (install, sudo, outside-workspace write)
    systemScopeExplanation?: string;  // Plain-English "what it touches outside the project"
    commandCategory?: string;
    canAlwaysAllow?: boolean;
    isProtectedFile?: boolean;
    isDeleteOrRename?: boolean;
    canAlwaysAllowFile?: boolean;
    canAlwaysAllowDirectory?: boolean;
    canAlwaysAllowExtension?: boolean;
    fileParentDir?: string;
    fileExtension?: string;
    timestamp: number;
}

/**
 * Map of operation ID to QueuedOperation
 * This is the source of truth for the permission queue panel
 */
export const permissionQueueAtom = atom<Map<string, QueuedOperation>>(new Map());

/**
 * Helper: Get operations by status
 */
export function getOperationsByStatus(queue: Map<string, QueuedOperation>, status: OperationStatus): QueuedOperation[] {
    return Array.from(queue.values())
        .filter(op => op.status === status)
        .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Helper: Update operation status
 */
export function updateOperationStatus(
    queue: Map<string, QueuedOperation>,
    id: string,
    updates: Partial<QueuedOperation>
): Map<string, QueuedOperation> {
    const newQueue = new Map(queue);
    const existing = newQueue.get(id);
    if (existing) {
        newQueue.set(id, { ...existing, ...updates });
    }
    return newQueue;
}

/**
 * Helper: Add new operation to queue
 */
export function addOperation(
    queue: Map<string, QueuedOperation>,
    operation: Omit<QueuedOperation, 'timestamp'>
): Map<string, QueuedOperation> {
    const newQueue = new Map(queue);
    newQueue.set(operation.id, {
        ...operation,
        timestamp: Date.now(),
    });
    return newQueue;
}

/**
 * Helper: Remove operation from queue
 */
export function removeOperation(
    queue: Map<string, QueuedOperation>,
    id: string
): Map<string, QueuedOperation> {
    const newQueue = new Map(queue);
    newQueue.delete(id);
    return newQueue;
}
