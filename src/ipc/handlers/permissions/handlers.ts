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
    type FileOperationPreview,
} from "@/lib/tools/permissions/schema";
import type { CommandPermissionDecision } from "@/lib/terminal-command-category";
import { getCommandCategory, isDangerousCategory } from "@/lib/terminal-command-category";
import { upsertWorkspaceCommandPermission } from "@/lib/command-permissions-store";
import { upsertWorkspaceFilePermission } from "@/lib/file-permissions-store";
import {
    getParentDirectory,
    getPathExtension,
    isProtectedRelativePath,
    normalizeRelativePath,
} from "@/lib/file-permission-scope";

const logger = log.scope("permission-handlers");

// Track active permission interceptors by chat ID
const activeInterceptors = new Map<number, PermissionInterceptor>();

export type PermissionApprovalMode =
    | "once"
    | "always_allow"
    | "deny"
    | "always_allow_file"
    | "always_allow_directory"
    | "always_allow_extension";

function isFileScopeApprovalMode(
    mode: PermissionApprovalMode,
): mode is "always_allow_file" | "always_allow_directory" | "always_allow_extension" {
    return (
        mode === "always_allow_file" ||
        mode === "always_allow_directory" ||
        mode === "always_allow_extension"
    );
}

/**
 * Send a panel intent update to the renderer process
 */
function sendPanelIntent(intent: string, context: unknown): void {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
        win.webContents.send("right-panel:set-intent", {
            intent,
            context,
            timestamp: Date.now(),
            source: "system",
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

    interceptor.on(
        "permission-request",
        (data: { operationId: string; request: PermissionRequest }) => {
            // Inline chat approval only — no right-panel permission intent.
            const windows = BrowserWindow.getAllWindows();
            for (const win of windows) {
                win.webContents.send("permission-request", {
                    chatId,
                    type: "permission-request",
                    operationId: data.operationId,
                    request: data.request,
                });
            }
        },
    );

    interceptor.on(
        "terminal-output",
        (data: {
            operationId: string;
            command: string;
            output: string;
            status: "running" | "completed" | "error";
            exitCode?: number;
        }) => {
            const isDevServer =
                data.command.includes("run dev") ||
                data.command.includes("start") ||
                data.command.includes("serve");

            if (isDevServer && data.status === "completed" && data.exitCode === 0) {
                logger.log(`[Panel Intent] Dev server completed, switching to show-preview`);
                sendPanelIntent("show-preview", {
                    chatId,
                    devServer: data.command,
                    message: "Dev server is running",
                    timestamp: Date.now(),
                });
            }
        },
    );
}

// ════════════════════════════════════════════════════════════════════════════
// IPC HANDLERS
// ════════════════════════════════════════════════════════════════════════════

ipcMain.handle(
    "execute-permission",
    async (
        _event: IpcMainInvokeEvent,
        {
            chatId,
            operationId,
            approvalMode = "once",
            appId,
            dangerAcknowledged,
            overrideContent,
        }: {
            chatId: number;
            operationId: string;
            approvalMode?: PermissionApprovalMode;
            appId?: number | null;
            dangerAcknowledged?: boolean;
            /** v10 per-hunk approval: composed partial content to write instead of the full proposal. */
            overrideContent?: string;
        },
    ): Promise<PermissionResult> => {
        logger.log(
            `Executing permission ${operationId} for chat ${chatId} mode=${approvalMode}`,
        );

        const interceptor = activeInterceptors.get(chatId);
        if (!interceptor) {
            return {
                operationId,
                approved: false,
                error: `No active permission interceptor for chat ${chatId}`,
            };
        }

        if (approvalMode === "deny") {
            return interceptor.rejectOperation(operationId);
        }

        const pending = interceptor.getPendingOperations().find((p) => p.id === operationId);
        const request = pending?.request;

        if (
            approvalMode === "always_allow" &&
            appId != null &&
            request?.operation === "run_command"
        ) {
            const preview = request.preview as { command?: string };
            const category = getCommandCategory(preview?.command ?? "");
            if (category && !isDangerousCategory(category)) {
                upsertWorkspaceCommandPermission(
                    appId,
                    category,
                    "always_allow" as CommandPermissionDecision,
                );
            }
        }

        if (appId != null && request && isFileScopeApprovalMode(approvalMode)) {
            const fp = request.preview as FileOperationPreview;
            const rel = fp?.path ? normalizeRelativePath(fp.path) : "";
            if (rel && !isProtectedRelativePath(rel)) {
                if (approvalMode === "always_allow_file") {
                    upsertWorkspaceFilePermission(appId, "file", rel, "always_allow");
                } else if (approvalMode === "always_allow_directory") {
                    const dir = getParentDirectory(rel);
                    if (dir) {
                        upsertWorkspaceFilePermission(appId, "directory", dir, "always_allow");
                    }
                } else if (approvalMode === "always_allow_extension") {
                    const ext = getPathExtension(rel);
                    if (ext) {
                        upsertWorkspaceFilePermission(appId, "extension", ext, "always_allow");
                    }
                }
            }
        }

        return interceptor.executeOperation(operationId, {
            dangerAcknowledged: dangerAcknowledged === true,
            overrideContent,
        });
    },
);

ipcMain.handle(
    "reject-permission",
    async (
        _event: IpcMainInvokeEvent,
        { chatId, operationId }: { chatId: number; operationId: string },
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
    },
);

ipcMain.handle(
    "execute-all-permissions",
    async (
        _event: IpcMainInvokeEvent,
        { chatId }: { chatId: number },
    ): Promise<PermissionResult[]> => {
        logger.log(`Executing all permissions for chat ${chatId}`);

        const interceptor = activeInterceptors.get(chatId);
        if (!interceptor) {
            return [];
        }

        return interceptor.executeAllOperations();
    },
);

ipcMain.handle(
    "reject-all-permissions",
    async (
        _event: IpcMainInvokeEvent,
        { chatId }: { chatId: number },
    ): Promise<PermissionResult[]> => {
        logger.log(`Rejecting all permissions for chat ${chatId}`);

        const interceptor = activeInterceptors.get(chatId);
        if (!interceptor) {
            return [];
        }

        return interceptor.rejectAllOperations();
    },
);

ipcMain.handle(
    "get-pending-permissions",
    async (
        _event: IpcMainInvokeEvent,
        { chatId }: { chatId: number },
    ): Promise<Array<{ id: string; request: PermissionRequest }>> => {
        const interceptor = activeInterceptors.get(chatId);
        if (!interceptor) {
            return [];
        }

        return interceptor.getPendingOperations();
    },
);
