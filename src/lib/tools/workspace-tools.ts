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
import fs from "fs/promises";
import { getAtlarixAppPath } from "../../paths/paths";

const execAsync = promisify(exec);

// ============================================
// CREATE WORKSPACE
// ============================================

/**
 * Create a new workspace (project folder)
 * AI calls this when user wants to build something
 */
ToolRegistry.register({
    name: "create_workspace",
    category: ToolCategory.FILE,
    description: "Create a new workspace (project folder) for building an app. Returns workspace ID and path.",
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
    },
    handler: async (params: {
        project_name?: string;
        description?: string;
        chatId?: number; // Injected by system
    }) => {
        try {
            // Generate project name
            const projectName = params.project_name || generateCuteAppName();

            // Create app in database
            const [app] = await db
                .insert(apps)
                .values({
                    name: projectName,
                    path: projectName,
                })
                .returning();

            // Create project directory
            const projectPath = getAtlarixAppPath(app.path);
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
