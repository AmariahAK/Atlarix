/**
 * Permission IPC Handlers
 * =======================
 * IPC handlers for executing/rejecting buffered permission requests.
 */

import { ipcMain, IpcMainInvokeEvent, BrowserWindow } from "electron";
import { z } from "zod";
import log from "electron-log";
import { showAgentNotification } from "@/main/agent-notification";
import { createLoggedHandler } from "@/ipc/handlers/safe_handle";
import { PermissionInterceptor } from "./interceptor";
import {
    PermissionRequest,
    PermissionResult,
    type FileOperationPreview,
} from "@/lib/tools/permissions/schema";
import type { CommandPermissionDecision } from "@/lib/terminal-command-category";
import { getCommandCategory } from "@/lib/terminal-command-category";
import { isDangerousCommand, dangerLabelKey } from "@/lib/dangerous-commands";
import { upsertWorkspaceCommandPermission } from "@/lib/command-permissions-store";
import { upsertWorkspaceFilePermission } from "@/lib/file-permissions-store";
import {
    getParentDirectory,
    getPathExtension,
    isProtectedRelativePath,
    normalizeRelativePath,
} from "@/lib/file-permission-scope";

const logger = log.scope("permission-handlers");

// Origin-gated + logged registration for the PRIVILEGED blanket-approval channels
// (a hijacked frame that could reach these could auto-approve destructive ops).
const gatedHandle = createLoggedHandler(logger);
const ChatIdPayloadSchema = z.object({ chatId: z.number() });

// Track active permission interceptors by chat ID
const activeInterceptors = new Map<number, PermissionInterceptor>();

/**
 * v13 7B: foreground commands still running after this long flip the chat
 * into the visible "waiting on command" state (square→send + timer chip).
 */
const WAITING_ON_COMMAND_AFTER_MS = 10_000;

type WaitTracker = { command: string; startedAt: number; timer: NodeJS.Timeout; announced: boolean };
const waitTrackersByChat = new Map<number, Map<string, WaitTracker>>();

function broadcastStreamPhase(payload: Record<string, unknown>): void {
    for (const win of BrowserWindow.getAllWindows()) {
        try {
            if (!win.isDestroyed()) win.webContents.send("chat:stream:phase", payload);
        } catch {
            /* window torn down mid-send */
        }
    }
}

export function clearWaitTrackersForChat(chatId: number): void {
    const trackers = waitTrackersByChat.get(chatId);
    if (!trackers) return;
    for (const [commandId, t] of trackers) {
        clearTimeout(t.timer);
        if (t.announced) {
            broadcastStreamPhase({ chatId, phase: "command_done", commandId });
        }
    }
    waitTrackersByChat.delete(chatId);
}

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
            // F1: when the app is UNFOCUSED and a turn is now waiting on the user,
            // raise the same OS notification used for "finished responding". The
            // in-app chime/toast covers the focused case. Different IPC channel from
            // Automations (permission-request vs automation:run-update) → no double-fire.
            const preview =
                (data.request as { title?: string; command?: string })?.title ??
                (data.request as { command?: string })?.command ??
                "A step needs your approval to continue.";
            void showAgentNotification("Atlarix needs your approval", preview);
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
            /** v13 7A: backgrounded commands never enter the waiting state. */
            background?: boolean;
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

            // v13 7B: a FOREGROUND command still running after 10s flips the
            // chat into the visible waiting state; completion flips it back.
            if (data.background) {
                // A5: a foreground command that AUTO-PROMOTED to the background
                // (v14 15s detach) re-emits a running event with background:true
                // under the SAME operationId. Clear its foreground wait tracker
                // so the amber "waiting on command" chip flips off and the turn
                // parks — its result now arrives via the background auto-wake.
                const promoted = waitTrackersByChat.get(chatId)?.get(data.operationId);
                if (promoted) {
                    clearTimeout(promoted.timer);
                    waitTrackersByChat.get(chatId)!.delete(data.operationId);
                    if (promoted.announced) {
                        broadcastStreamPhase({
                            chatId,
                            phase: "command_done",
                            commandId: data.operationId,
                        });
                    }
                }
                return;
            }
            let trackers = waitTrackersByChat.get(chatId);
            if (data.status === "running") {
                if (!trackers) {
                    trackers = new Map();
                    waitTrackersByChat.set(chatId, trackers);
                }
                if (!trackers.has(data.operationId)) {
                    const startedAt = Date.now();
                    const tracker: WaitTracker = {
                        command: data.command,
                        startedAt,
                        announced: false,
                        timer: setTimeout(() => {
                            tracker.announced = true;
                            broadcastStreamPhase({
                                chatId,
                                phase: "waiting_on_command",
                                commandId: data.operationId,
                                command: tracker.command,
                                startedAt,
                            });
                        }, WAITING_ON_COMMAND_AFTER_MS),
                    };
                    trackers.set(data.operationId, tracker);
                }
                return;
            }
            // completed / error
            const tracker = trackers?.get(data.operationId);
            if (tracker) {
                clearTimeout(tracker.timer);
                trackers!.delete(data.operationId);
                if (tracker.announced) {
                    broadcastStreamPhase({
                        chatId,
                        phase: "command_done",
                        commandId: data.operationId,
                    });
                }
            }
        },
    );
}

// ════════════════════════════════════════════════════════════════════════════
// IPC HANDLERS
// ════════════════════════════════════════════════════════════════════════════

const executePermissionHandler = async (
        _event: IpcMainInvokeEvent,
        {
            chatId,
            operationId,
            approvalMode = "once",
            appId,
            overrideContent,
        }: {
            chatId: number;
            operationId: string;
            approvalMode?: PermissionApprovalMode;
            appId?: number | null;
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
            // v14.7: rejectOperation resolves the (now blocking) waitForApproval
            // directly — the turn continues in-loop; no parked-turn wake needed.
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
            const command = preview?.command ?? "";
            // Dangerous commands persist under their fine-grained `danger:<id>`
            // key (so this allow can't be satisfied by a coarse first-token
            // allow, and vice-versa); everything else persists by first-token
            // category. Dangerous commands are now always-allowable — the safety
            // guarantee lives in resolveRunCommandPermissionGate (never silently
            // auto-approved until such a rule exists).
            const key = isDangerousCommand(command)
                ? dangerLabelKey(command)
                : getCommandCategory(command);
            if (key) {
                upsertWorkspaceCommandPermission(
                    appId,
                    key,
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

        // v14.7: executeOperation resolves the (now blocking) waitForApproval
        // directly — the turn continues in-loop with the result.
        return await interceptor.executeOperation(operationId, {
            overrideContent,
        });
    };

ipcMain.handle("execute-permission", executePermissionHandler);

// "Done responding" desktop notification. The renderer fires this at turn-end
// when the app is unfocused; main shows the SAME OS notification used for the
// waiting-on-user case (setting-gated, DND-honored, click-to-focus).
ipcMain.handle(
    "notify:turn-done",
    (_event: IpcMainInvokeEvent, data?: { waitingOnUser?: boolean }) => {
        if (data?.waitingOnUser) {
            void showAgentNotification("Atlarix needs your answer", "Your input is needed to continue.");
        } else {
            void showAgentNotification("Atlarix finished responding", "Your turn is ready to review.");
        }
    },
);

/** The live execute-permission handler for in-process automation auto-approval. */
export function getExecutePermissionHandler(): typeof executePermissionHandler {
    return executePermissionHandler;
}

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

        // v14.7: rejectOperation resolves the (now blocking) waitForApproval directly.
        return interceptor.rejectOperation(operationId);
    },
);

gatedHandle(
    "execute-all-permissions",
    async (
        _event: IpcMainInvokeEvent,
        rawPayload: unknown,
    ): Promise<PermissionResult[]> => {
        const { chatId } = ChatIdPayloadSchema.parse(rawPayload);
        logger.log(`Executing all permissions for chat ${chatId}`);

        const interceptor = activeInterceptors.get(chatId);
        if (!interceptor) {
            return [];
        }

        return interceptor.executeAllOperations();
    },
);

gatedHandle(
    "reject-all-permissions",
    async (
        _event: IpcMainInvokeEvent,
        rawPayload: unknown,
    ): Promise<PermissionResult[]> => {
        const { chatId } = ChatIdPayloadSchema.parse(rawPayload);
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
