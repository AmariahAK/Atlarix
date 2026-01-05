/**
 * Permission IPC Handlers
 * =======================
 * IPC handlers for executing/rejecting buffered permission requests.
 */

import { ipcMain, IpcMainInvokeEvent, BrowserWindow } from "electron";
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
 * Send a panel intent update to the renderer process
 * This allows the main process to control what the right panel shows
 * using semantic intents that get mapped to correct UI components.
 * 
 * Intent values:
 * - 'show-permissions': Show file/command approval UI → maps to FileDiffPanel
 * - 'show-file-changes': Show file diff viewer → maps to FileDiffPanel
 * - 'show-web-search': Show web search results → maps to WebSearchPanel
 * - 'show-diagram': Show architecture diagram → maps to DiagramPanel
 * - 'show-terminal': Show command output → maps to TerminalPanel
 * - 'empty': Clear the panel
 */
function sendPanelIntent(intent: string, context: any): void {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
        win.webContents.send('right-panel:set-intent', {
            intent,
            context,
            timestamp: Date.now(),
            source: 'system',
        });
    }
    logger.log(`[Panel Intent] Sent intent: ${intent}`);
}

/**
 * Register an interceptor for a chat session
 */
export function registerInterceptor(chatId: number, interceptor: PermissionInterceptor): void {
    activeInterceptors.set(chatId, interceptor);
    logger.log(`Registered permission interceptor for chat ${chatId}`);

    // Wire up permission-request event to update the right panel with intent
    interceptor.on('permission-request', (data: { operationId: string; request: PermissionRequest }) => {
        logger.log(`[Panel Intent] Setting show-permissions for ${data.operationId}`);

        // Send semantic intent - frontend will map 'show-permissions' to permission UI
        sendPanelIntent('show-permissions', {
            operationId: data.operationId,
            operation: data.request.operation,
            chatId, // Include chatId for PermissionQueuePanel
            message: `AI wants to: ${data.request.operation}`,
            timestamp: Date.now(),
        });

        // 🚀 Also emit permission-request IPC event for PermissionQueuePanel
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
            win.webContents.send('permission-request', {
                chatId,
                type: 'permission-request',
                operationId: data.operationId,
                request: data.request,
            });
        }
    });

    // Wire up terminal-output event to switch to preview panel when dev server succeeds
    interceptor.on('terminal-output', (data: {
        operationId: string;
        command: string;
        output: string;
        status: 'running' | 'completed' | 'error';
        exitCode?: number;
    }) => {
        // When dev server completes successfully, switch to preview panel
        const isDevServer = data.command.includes('run dev') ||
            data.command.includes('start') ||
            data.command.includes('serve');

        if (isDevServer && data.status === 'completed' && data.exitCode === 0) {
            logger.log(`[Panel Intent] Dev server completed, switching to show-preview`);
            sendPanelIntent('show-preview', {
                chatId,
                devServer: data.command,
                message: 'Dev server is running',
                timestamp: Date.now(),
            });
        }
    });
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
