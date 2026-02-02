/**
 * Diagram IPC Handlers
 * ====================
 * Handle diagram CRUD operations, version history, and export
 */

import { ipcMain } from "electron";
import { db } from "@/db";
import { diagrams, diagramVersions } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { generateText } from "ai";
import { getModelClient } from "../utils/get_model_client";
import { extractCodebase } from "../../utils/codebase";
import { getAtlarixAppPath } from "../../paths/paths";
import { readSettings } from "../../main/settings";
import { AppChatContext } from "../../lib/schemas";
import { apps } from "@/db/schema";
import { generateFingerprint } from "../../lib/analysis/fingerprint";
import { checkDiagramStaleness, type StalenessCheck } from "../../lib/analysis/staleness";
import { DiagramUpdateStrategy } from "../../lib/diagram/diagram_update_strategy";
import { GitChangeTracker } from "../../lib/diagram/git_change_tracker";

// ============================================
// TYPES
// ============================================

/** Git-based diagram decision for Update vs Regenerate (returned with check-staleness when repo is git) */
export interface GitDiagramDecision {
    action: "none" | "update" | "regenerate";
    reason: string;
    confidence: number;
    totalFiles: number;
    linesAdded: number;
    linesDeleted: number;
}

export interface DiagramInput {
    workspaceId?: number;
    chatId?: number;
    type: "mermaid" | "architecture" | "sequence" | "class" | "flowchart";
    title: string;
    content: string;
    metadata?: {
        files?: string[];
        entities?: string[];
        focus?: string;
    };
}

// ============================================
// DIAGRAM:GENERATE - Create new diagram
// ============================================

ipcMain.handle(
    "diagram:generate",
    async (_, input: DiagramInput) => {
        try {
            const [diagram] = await db
                .insert(diagrams)
                .values({
                    workspaceId: input.workspaceId,
                    chatId: input.chatId,
                    type: input.type,
                    title: input.title,
                    content: input.content,
                    metadata: input.metadata,
                })
                .returning();

            console.log(`📊 [diagram:generate] Created diagram "${input.title}" (ID: ${diagram.id})`);

            return {
                success: true,
                diagram,
            };
        } catch (error) {
            console.error("[diagram:generate] Error:", error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    }
);

// ============================================
// DIAGRAM:GENERATE-AI - Create new diagram using AI
// ============================================

ipcMain.handle(
    "diagram:generate-ai",
    async (_, { workspaceId, title }: { workspaceId: number; title?: string }) => {
        try {
            console.log(`📊 [diagram:generate-ai] Starting generation for workspace ${workspaceId}`);

            // 1. Get Workspace Path
            const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId));
            if (!app) throw new Error("Workspace not found");

            // Use app.path directly - this is the actual location of the workspace
            // For imported apps, app.path is absolute (e.g., /Users/x/Documents/GitHub/Project)
            // For created apps, app.path is also set correctly
            const appPath = app.path;
            const settings = readSettings();

            // 2. Extract Codebase Context
            // Use default context settings (empty paths = include all non-ignored)
            const chatContext: AppChatContext = {
                contextPaths: [],
                smartContextAutoIncludes: [],
                excludePaths: []
            };

            console.log(`📊 [diagram:generate-ai] Extracting codebase from ${appPath}`);
            const { formattedOutput } = await extractCodebase({
                appPath,
                chatContext
            });

            // 3. Prepare AI Client
            // Use the currently selected model from settings
            const modelConfig = settings.selectedModel;
            const { modelClient } = await getModelClient(modelConfig, settings);

            // 4. Generate Diagram
            const systemPrompt = `You are an expert software architect.
Analyze the provided codebase and generate a Mermaid.js diagram that best represents the high-level architecture.
Focus on:
- Major components/modules
- Data flow
- relationships between files
- External dependencies (if obvious)

Requirements:
- Return ONLY the mermaid code block.
- Use 'graph TB' or 'graph LR'.
- Do NOT use 'classDiagram' unless specifically appropriate for OOP analysis.
- Keep the diagram clean and readable (avoid too many nodes).
- Group related components in subgraphs.`;

            const userPrompt = `Generate an architecture diagram for this project:

${formattedOutput.substring(0, 50000)} // Limit context to 50k chars to avoid huge costs/errors if project is massive`;

            console.log(`📊 [diagram:generate-ai] sending prompt to model ${modelConfig.name}`);
            const result = await generateText({
                model: modelClient.model,
                system: systemPrompt,
                messages: [{ role: 'user', content: userPrompt }],
            });

            // 5. Parse Output
            let content = result.text;
            // distinct mermaid block
            const match = content.match(/```mermaid\n([\s\S]*?)\n```/) || content.match(/```\n([\s\S]*?)\n```/);
            if (match) {
                content = match[1];
            }
            content = content.trim();

            // 6. Generate fingerprint for staleness tracking
            const fingerprint = await generateFingerprint(appPath);

            // 6b. Infer workflow from project (for Diagram tab Workflow mode)
            let workflowMetadata: { nodes?: unknown[]; connections?: unknown } | undefined;
            try {
                const { inferWorkflowFromProject } = await import("../../lib/workflow/project_to_workflow");
                const inferred = await inferWorkflowFromProject(appPath);
                if (inferred) {
                    workflowMetadata = { nodes: inferred.nodes, connections: inferred.connections };
                }
            } catch (e) {
                console.warn("[diagram:generate-ai] Workflow inference skipped:", e);
            }

            // 7. Save to DB with fingerprint and optional workflow
            const [diagram] = await db
                .insert(diagrams)
                .values({
                    workspaceId,
                    type: "mermaid",
                    title: title || `${app.name} Architecture (AI)`,
                    content,
                    metadata: {
                        focus: "ai-generated",
                        ...(workflowMetadata && { workflow: workflowMetadata }),
                    },
                    fingerprintHash: fingerprint.hash,
                    fingerprintData: fingerprint,
                    createdFromFileCount: fingerprint.fileCount,
                })
                .returning();

            console.log(`📊 [diagram:generate-ai] Created diagram ${diagram.id}`);
            return { success: true, diagram };

        } catch (error: unknown) {
            console.error("[diagram:generate-ai] Error:", error);
            let message = error instanceof Error ? error.message : "Unknown error";
            if (typeof (error as { statusCode?: number })?.statusCode === "number") {
                const code = (error as { statusCode: number }).statusCode;
                if (code === 401) message = "API key invalid or user not found. Check your OpenRouter (or selected provider) API key in Settings.";
                else if (code >= 400 && code < 500) message = `API error (${code}). Check your API key and model in Settings.`;
            }
            const msgLower = String(message).toLowerCase();
            if (msgLower.includes("user not found") || msgLower.includes("401")) {
                message = "API key invalid or user not found. Check your OpenRouter (or selected provider) API key in Settings.";
            }
            return {
                success: false,
                error: message,
            };
        }
    }
);

// ============================================
// DIAGRAM:LIST - List all diagrams for workspace
// ============================================

ipcMain.handle(
    "diagram:list",
    async (_, { workspaceId }: { workspaceId?: number }) => {
        try {
            let query = db.select().from(diagrams);

            if (workspaceId) {
                query = query.where(eq(diagrams.workspaceId, workspaceId)) as typeof query;
            }

            const results = await query.orderBy(desc(diagrams.updatedAt));

            console.log(`📊 [diagram:list] Found ${results.length} diagrams`);

            return {
                success: true,
                diagrams: results,
            };
        } catch (error) {
            console.error("[diagram:list] Error:", error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
                diagrams: [],
            };
        }
    }
);

// ============================================
// DIAGRAM:CHECK-STALENESS - Check if diagram is outdated
// ============================================

ipcMain.handle(
    "diagram:check-staleness",
    async (
        _,
        { diagramId, workspacePath }: { diagramId: number; workspacePath: string }
    ): Promise<{
        success: boolean;
        staleness?: StalenessCheck;
        gitDecision?: GitDiagramDecision;
        error?: string;
    }> => {
        try {
            console.log(`📊 [diagram:check-staleness] Checking diagram ${diagramId}`);

            const [diagram] = await db
                .select()
                .from(diagrams)
                .where(eq(diagrams.id, diagramId));

            if (!diagram) {
                return { success: false, error: "Diagram not found" };
            }

            const staleness = await checkDiagramStaleness(
                diagram.fingerprintData,
                diagram.createdFromFileCount,
                workspacePath
            );

            // Git-based decision when diagram has last commit and workspace is git
            let gitDecision: GitDiagramDecision | undefined;
            const meta = diagram.metadata as { gitCommit?: string } | null | undefined;
            const lastDiagramCommit = meta?.gitCommit;
            if (lastDiagramCommit && workspacePath) {
                try {
                    const tracker = new GitChangeTracker(workspacePath);
                    if (await tracker.isGitRepo()) {
                        const strategy = new DiagramUpdateStrategy(workspacePath);
                        const decision = await strategy.decideDiagramAction(lastDiagramCommit);
                        if (decision.action !== "none") {
                            gitDecision = {
                                action: decision.action,
                                reason: decision.reason,
                                confidence: decision.confidence,
                                totalFiles: decision.changes.totalFiles,
                                linesAdded: decision.changes.linesAdded,
                                linesDeleted: decision.changes.linesDeleted,
                            };
                            console.log(`📊 [diagram:check-staleness] Git decision: ${decision.action} (${decision.reason})`);
                        }
                    }
                } catch (gitErr) {
                    console.warn("[diagram:check-staleness] Git decision skipped:", gitErr);
                }
            }

            console.log(`📊 [diagram:check-staleness] Result: ${staleness.severity} (${staleness.reason})`);

            return { success: true, staleness, gitDecision };
        } catch (error) {
            console.error("[diagram:check-staleness] Error:", error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    }
);

// ============================================
// DIAGRAM:GET - Get single diagram by ID
// ============================================

ipcMain.handle(
    "diagram:get",
    async (_, { id }: { id: number }) => {
        try {
            const [diagram] = await db
                .select()
                .from(diagrams)
                .where(eq(diagrams.id, id));

            if (!diagram) {
                return { success: false, error: "Diagram not found" };
            }

            return { success: true, diagram };
        } catch (error) {
            console.error("[diagram:get] Error:", error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    }
);

// ============================================
// DIAGRAM:UPDATE - Update diagram and save version
// ============================================

ipcMain.handle(
    "diagram:update",
    async (
        _,
        {
            id,
            content,
            changeDescription,
        }: {
            id: number;
            content: string;
            changeDescription?: string;
        }
    ) => {
        try {
            // Get current diagram to save as version
            const [currentDiagram] = await db
                .select()
                .from(diagrams)
                .where(eq(diagrams.id, id));

            if (!currentDiagram) {
                return { success: false, error: "Diagram not found" };
            }

            // Save current version before updating
            await db.insert(diagramVersions).values({
                diagramId: id,
                content: currentDiagram.content,
                changeDescription: changeDescription || "Updated diagram",
            });

            // Update diagram with new content
            const [updated] = await db
                .update(diagrams)
                .set({
                    content,
                    updatedAt: new Date(),
                })
                .where(eq(diagrams.id, id))
                .returning();

            console.log(`📊 [diagram:update] Updated diagram ${id}, saved version`);

            return { success: true, diagram: updated };
        } catch (error) {
            console.error("[diagram:update] Error:", error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    }
);

// ============================================
// DIAGRAM:DELETE - Delete a diagram
// ============================================

ipcMain.handle("diagram:delete", async (_, { id }: { id: number }) => {
    try {
        await db.delete(diagrams).where(eq(diagrams.id, id));
        console.log(`📊 [diagram:delete] Deleted diagram ${id}`);
        return { success: true };
    } catch (error) {
        console.error("[diagram:delete] Error:", error);
        return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
        };
    }
});

// ============================================
// DIAGRAM:HISTORY - Get version history
// ============================================

ipcMain.handle(
    "diagram:history",
    async (_, { diagramId }: { diagramId: number }) => {
        try {
            const versions = await db
                .select()
                .from(diagramVersions)
                .where(eq(diagramVersions.diagramId, diagramId))
                .orderBy(desc(diagramVersions.createdAt));

            console.log(`📊 [diagram:history] Found ${versions.length} versions for diagram ${diagramId}`);

            return { success: true, versions };
        } catch (error) {
            console.error("[diagram:history] Error:", error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
                versions: [],
            };
        }
    }
);

// ============================================
// DIAGRAM:RESTORE - Restore a previous version
// ============================================

ipcMain.handle(
    "diagram:restore",
    async (_, { diagramId, versionId }: { diagramId: number; versionId: number }) => {
        try {
            // Get the version to restore
            const [version] = await db
                .select()
                .from(diagramVersions)
                .where(eq(diagramVersions.id, versionId));

            if (!version) {
                return { success: false, error: "Version not found" };
            }

            // Get current diagram to save as version first
            const [currentDiagram] = await db
                .select()
                .from(diagrams)
                .where(eq(diagrams.id, diagramId));

            if (!currentDiagram) {
                return { success: false, error: "Diagram not found" };
            }

            // Save current as version
            await db.insert(diagramVersions).values({
                diagramId,
                content: currentDiagram.content,
                changeDescription: "Before restore",
            });

            // Restore the old version
            const [updated] = await db
                .update(diagrams)
                .set({
                    content: version.content,
                    updatedAt: new Date(),
                })
                .where(eq(diagrams.id, diagramId))
                .returning();

            console.log(`📊 [diagram:restore] Restored diagram ${diagramId} to version ${versionId}`);

            return { success: true, diagram: updated };
        } catch (error) {
            console.error("[diagram:restore] Error:", error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    }
);

// ============================================
// DIAGRAM:EXPORT - Export as SVG
// ============================================

ipcMain.handle(
    "diagram:export",
    async (_, { id, format }: { id: number; format: "svg" | "png" | "code" }) => {
        try {
            const [diagram] = await db
                .select()
                .from(diagrams)
                .where(eq(diagrams.id, id));

            if (!diagram) {
                return { success: false, error: "Diagram not found" };
            }

            if (format === "code") {
                return {
                    success: true,
                    data: diagram.content,
                    mimeType: "text/plain",
                    filename: `${diagram.title}.mmd`,
                };
            }

            // For SVG/PNG, the actual rendering happens in the renderer process
            // We just return the content for client-side rendering
            return {
                success: true,
                data: diagram.content,
                type: diagram.type,
                title: diagram.title,
                format,
            };
        } catch (error) {
            console.error("[diagram:export] Error:", error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    }
);

// ============================================
// DIAGRAM:REGENERATE-BACKGROUND - Background regeneration
// Triggered by post-sequence diagram refresh engine
// ============================================

ipcMain.handle(
    "diagram:regenerate-background",
    async (_, { workspaceId }: { workspaceId: number }) => {
        try {
            console.log(`📊 [diagram:regenerate-background] Regenerating diagram for workspace ${workspaceId}`);

            // 1. Get Workspace Path
            const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId));
            if (!app) {
                console.log(`[diagram:regenerate-background] Workspace not found: ${workspaceId}`);
                return { success: false, error: "Workspace not found" };
            }

            // Use app.path directly - this is the actual location of the workspace
            const appPath = app.path;
            const settings = readSettings();

            // 2. Extract Codebase Context
            const chatContext: AppChatContext = {
                contextPaths: [],
                smartContextAutoIncludes: [],
                excludePaths: []
            };

            console.log(`📊 [diagram:regenerate-background] Extracting codebase from ${appPath}`);
            const { formattedOutput } = await extractCodebase({
                appPath,
                chatContext
            });

            // 3. Prepare AI Client
            const modelConfig = settings.selectedModel;
            const { modelClient } = await getModelClient(modelConfig, settings);

            // 4. Generate Diagram
            const systemPrompt = `You are an expert software architect.
Analyze the provided codebase and generate a Mermaid.js diagram that best represents the high-level architecture.
Focus on:
- Major components/modules
- Data flow
- relationships between files
- External dependencies (if obvious)

Requirements:
- Return ONLY the mermaid code block.
- Use 'graph TB' or 'graph LR'.
- Do NOT use 'classDiagram' unless specifically appropriate for OOP analysis.
- Keep the diagram clean and readable (avoid too many nodes).
- Group related components in subgraphs.`;

            const userPrompt = `Generate an architecture diagram for this project:\n\n${formattedOutput.substring(0, 50000)}`;

            console.log(`📊 [diagram:regenerate-background] Sending prompt to model ${modelConfig.name}`);
            const result = await generateText({
                model: modelClient.model,
                system: systemPrompt,
                messages: [{ role: 'user', content: userPrompt }],
            });

            // 5. Parse Output
            let content = result.text;
            const match = content.match(/```mermaid\n([\s\S]*?)\n```/) || content.match(/```\n([\s\S]*?)\n```/);
            if (match) {
                content = match[1];
            }
            content = content.trim();

            // 6. Generate fingerprint
            const fingerprint = await generateFingerprint(appPath);

            // 7. Check for existing diagram and update or create
            const existingDiagram = await db.query.diagrams.findFirst({
                where: eq(diagrams.workspaceId, workspaceId),
            });

            if (existingDiagram) {
                await db
                    .update(diagrams)
                    .set({
                        content,
                        fingerprintHash: fingerprint.hash,
                        fingerprintData: fingerprint,
                        createdFromFileCount: fingerprint.fileCount,
                        updatedAt: new Date(),
                    })
                    .where(eq(diagrams.id, existingDiagram.id));

                console.log(`📊 [diagram:regenerate-background] Updated diagram ${existingDiagram.id}`);
                return { success: true, action: 'updated', diagramId: existingDiagram.id };
            } else {
                const [diagram] = await db
                    .insert(diagrams)
                    .values({
                        workspaceId,
                        type: "mermaid",
                        title: `${app.name} Architecture`,
                        content,
                        metadata: { focus: "auto-generated" },
                        fingerprintHash: fingerprint.hash,
                        fingerprintData: fingerprint,
                        createdFromFileCount: fingerprint.fileCount,
                    })
                    .returning();

                console.log(`📊 [diagram:regenerate-background] Created new diagram ${diagram.id}`);
                return { success: true, action: 'created', diagramId: diagram.id };
            }

        } catch (error) {
            console.error("[diagram:regenerate-background] Error:", error);
            return {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    }
);
