/**
 * Workspace Management Tools
 * ===========================
 * Tools for creating and managing workspaces (projects)
 */

import { ToolRegistry, ToolCategory } from "./registry";
import { generateCuteAppName } from "../utils";
import { db } from "../../db";
import { apps, chats } from "../../db/schema";
import { eq } from "drizzle-orm";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "node:os";
import fs from "fs/promises";
import { getAtlarixAppPath } from "../../paths/paths";
import { SubscriptionManager } from "../SubscriptionManager";

const execAsync = promisify(exec);

/** Default base for new workspaces when target_path is not provided (no longer atlarix-apps). */
const DEFAULT_WORKSPACE_BASE = path.join(os.homedir(), "Documents", "Atlarix");

// ============================================
// CREATE WORKSPACE
// ============================================

/**
 * Create a new workspace (project folder)
 * AI calls this when user wants to build something.
 * New workspaces use target_path (absolute) when provided, otherwise ~/Documents/Atlarix/{name}.
 */
ToolRegistry.register({
    name: "create_workspace",
    category: ToolCategory.FILE,
    description: "Create a new workspace (project folder) for building an app. Returns workspace ID and path. Prefer target_path (absolute) for user-chosen project root; otherwise uses ~/Documents/Atlarix/{name}.",
    cost: 5,
    requiresWorkspace: false, // Called BEFORE workspace exists
    isCore: true, // Always available
    parameters: {
        project_name: {
            type: "string",
            description: "Optional: Project name (will generate cute name if not provided)",
            required: false,
        },
        description: {
            type: "string",
            description: "Brief description of what this workspace is for",
            required: false,
        },
        target_path: {
            type: "string",
            description: "Optional: Absolute path for project root. When set, workspace is created there; otherwise ~/Documents/Atlarix/{name}.",
            required: false,
        },
    },
    handler: async (params: {
        project_name?: string;
        description?: string;
        target_path?: string;
        chatId?: number; // Injected by system
    }) => {
        try {
            // ════════════════════════════════════════════════════════════
            // FREEMIUM CHECK: Free tier allows 1 workspace only
            // ════════════════════════════════════════════════════════════
            const workspaceLimitCheck = await SubscriptionManager.canCreateWorkspace();

            if (!workspaceLimitCheck.allowed) {
                // Get current workspace details for the upgrade modal
                const currentWorkspace = await SubscriptionManager.getCurrentWorkspaceDetails();

                // Return permission request for the UI to show upgrade modal
                return {
                    __permission_required: true,
                    operation: 'upgrade_required',
                    limit_type: 'workspace',
                    current_count: workspaceLimitCheck.currentCount,
                    max_allowed: workspaceLimitCheck.maxAllowed,
                    current_workspace: currentWorkspace,
                    reason: workspaceLimitCheck.reason,
                    upgrade_message: `🚀 Free tier includes 1 workspace with all features.

Your current workspace: "${currentWorkspace?.name || 'Unknown'}"
• ${currentWorkspace?.diagramCount || 0} diagrams saved

To create a new workspace, you can:
1. Delete your current workspace (loses data)
2. Upgrade to Pro ($19/mo) for unlimited workspaces

Would you like to upgrade or delete the existing workspace?`,
                };
            }

            // Generate project name
            const projectName = params.project_name || generateCuteAppName();

            // Resolve project root: target_path (must be absolute) or default ~/Documents/Atlarix/{name}
            // Only use target_path if it is truly absolute (leading / on Unix, C:\ on Windows).
            // Paths like "Users/amariah/..." are relative and would create wrong nested structure.
            const rawTarget = params.target_path?.trim();
            const useTargetPath = rawTarget && path.isAbsolute(rawTarget);
            const projectPath = useTargetPath
                ? path.resolve(rawTarget!)
                : path.join(DEFAULT_WORKSPACE_BASE, projectName);

            // Create app in database; store absolute path so workspace is at project root (no atlarix-apps)
            const [app] = await db
                .insert(apps)
                .values({
                    name: projectName,
                    path: projectPath,
                })
                .returning();

            // Clear workspace count cache
            SubscriptionManager.clearWorkspaceCache();

            // Create project directory
            await fs.mkdir(projectPath, { recursive: true });

            // Initialize git repository
            await execAsync("git init", { cwd: projectPath });
            await execAsync("git config user.email 'atlarix@ai.dev'", { cwd: projectPath });
            await execAsync("git config user.name 'Atlarix AI'", { cwd: projectPath });

            // Create initial README
            const readmeContent = `# ${projectName}\n\n${params.description || "Created with Atlarix AI"}\n`;
            await fs.writeFile(
                path.join(projectPath, "README.md"),
                readmeContent,
                "utf-8"
            );

            // Initial commit
            await execAsync("git add .", { cwd: projectPath });
            await execAsync('git commit -m "Init Atlarix app"', {
                cwd: projectPath,
            });

            // Update chat to link to this workspace
            if (params.chatId) {
                await db
                    .update(chats)
                    .set({ appId: app.id })
                    .where(eq(chats.id, params.chatId));
            }

            return {
                success: true,
                workspace_id: app.id,
                workspace_name: app.name,
                workspace_path: projectPath,
                message: `✅ Created workspace "${projectName}"

Now you can:
- Call apply_template() to use a starter template
- Call write_file() to create files from scratch
- Call git_status() to check repository state

What would you like to build?`,
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});

// ============================================
// LIST WORKSPACES
// ============================================

/**
 * List all available workspaces
 */
ToolRegistry.register({
    name: "list_workspaces",
    category: ToolCategory.FILE,
    description: "List all workspaces (projects) the user has created",
    cost: 1,
    requiresWorkspace: false,
    isCore: true,
    parameters: {},
    handler: async () => {
        try {
            const allApps = await db.query.apps.findMany({
                orderBy: (apps, { desc }) => [desc(apps.createdAt)],
            });

            if (allApps.length === 0) {
                return {
                    success: true,
                    workspaces: [],
                    message: "No workspaces yet. Call create_workspace() to start building!",
                };
            }

            return {
                success: true,
                workspaces: allApps.map((app) => ({
                    id: app.id,
                    name: app.name,
                    path: app.path,
                    created: app.createdAt,
                })),
                total: allApps.length,
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});

// ============================================
// SWITCH WORKSPACE
// ============================================

/**
 * Switch to a different workspace
 */
ToolRegistry.register({
    name: "switch_workspace",
    category: ToolCategory.FILE,
    description: "Switch current chat to a different workspace",
    cost: 1,
    requiresWorkspace: false,
    isCore: true,
    parameters: {
        workspace_id: {
            type: "number",
            description: "Workspace ID to switch to",
            required: true,
        },
    },
    handler: async (params: { workspace_id: number; chatId?: number }) => {
        try {
            if (!params.chatId) {
                return {
                    success: false,
                    error: "No active chat to switch",
                };
            }

            // Verify workspace exists
            const workspace = await db.query.apps.findFirst({
                where: (apps, { eq }) => eq(apps.id, params.workspace_id),
            });

            if (!workspace) {
                return {
                    success: false,
                    error: `Workspace ${params.workspace_id} not found`,
                };
            }

            // Update chat's workspace
            await db
                .update(chats)
                .set({ appId: params.workspace_id })
                .where(eq(chats.id, params.chatId));

            return {
                success: true,
                workspace_id: workspace.id,
                workspace_name: workspace.name,
                message: `Switched to workspace "${workspace.name}"`,
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    },
});
