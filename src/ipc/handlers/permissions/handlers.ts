/**
 * Permission IPC Handlers
 * =======================
 * IPC handlers for executing/rejecting buffered permission requests.
 */

import { ipcMain, IpcMainInvokeEvent } from "electron";
import log from "electron-log";
import { PermissionInterceptor } from "./interceptor";
import {
    PermissionRequest,
    PermissionResult,
} from "@/lib/tools/permissions/schema";

const logger = log.scope("permission-handlers");

// Track active permission interceptors by chat ID
const activeInterceptors = new Map<number, PermissionInterceptor>();

/**
 * Register an interceptor for a chat session
 */
export function registerInterceptor(chatId: number, interceptor: PermissionInterceptor): void {
    activeInterceptors.set(chatId, interceptor);
    logger.log(`Registered permission interceptor for chat ${chatId}`);
}

/**
 * Get the interceptor for a chat session
 */
export function getInterceptor(chatId: number): PermissionInterceptor | undefined {
    return activeInterceptors.get(chatId);
}

/**
 * Clear the interceptor for a chat session
 */
export function clearInterceptor(chatId: number): void {
    activeInterceptors.delete(chatId);
    logger.log(`Cleared permission interceptor for chat ${chatId}`);
}

// ════════════════════════════════════════════════════════════════════════════
// IPC HANDLERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Execute a pending permission operation
 */
ipcMain.handle(
    "execute-permission",
    async (
        _event: IpcMainInvokeEvent,
        { chatId, operationId }: { chatId: number; operationId: string }
    ): Promise<PermissionResult> => {
        logger.log(`Executing permission ${operationId} for chat ${chatId}`);

        const interceptor = activeInterceptors.get(chatId);
        if (!interceptor) {
            return {
                operationId,
                approved: false,
                error: `No active permission interceptor for chat ${chatId}`,
            };
        }

        return interceptor.executeOperation(operationId);
    }
);

/**
 * Reject a pending permission operation
 */
ipcMain.handle(
    "reject-permission",
    async (
        _event: IpcMainInvokeEvent,
        { chatId, operationId }: { chatId: number; operationId: string }
    ): Promise<PermissionResult> => {
        logger.log(`Rejecting permission ${operationId} for chat ${chatId}`);

        const interceptor = activeInterceptors.get(chatId);
        if (!interceptor) {
            return {
                operationId,
                approved: false,
                error: `No active permission interceptor for chat ${chatId}`,
            };
        }

        return interceptor.rejectOperation(operationId);
    }
);

/**
 * Execute all pending permission operations (batch approval)
 */
ipcMain.handle(
    "execute-all-permissions",
    async (
        _event: IpcMainInvokeEvent,
        { chatId }: { chatId: number }
    ): Promise<PermissionResult[]> => {
        logger.log(`Executing all permissions for chat ${chatId}`);

        const interceptor = activeInterceptors.get(chatId);
        if (!interceptor) {
            return [];
        }

        return interceptor.executeAllOperations();
    }
);

/**
 * Reject all pending permission operations
 */
ipcMain.handle(
    "reject-all-permissions",
    async (
        _event: IpcMainInvokeEvent,
        { chatId }: { chatId: number }
    ): Promise<PermissionResult[]> => {
        logger.log(`Rejecting all permissions for chat ${chatId}`);

        const interceptor = activeInterceptors.get(chatId);
        if (!interceptor) {
            return [];
        }

        return interceptor.rejectAllOperations();
    }
);

/**
 * Get all pending permission operations for a chat
 */
ipcMain.handle(
    "get-pending-permissions",
    async (
        _event: IpcMainInvokeEvent,
        { chatId }: { chatId: number }
    ): Promise<Array<{ id: string; request: PermissionRequest }>> => {
        const interceptor = activeInterceptors.get(chatId);
        if (!interceptor) {
            return [];
        }

        return interceptor.getPendingOperations();
    }
);
