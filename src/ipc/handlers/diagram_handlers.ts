/**
 * Diagram IPC Handlers
 * ====================
 * Handle diagram CRUD operations, version history, and export
 */

import { ipcMain, BrowserWindow } from "electron";
import { db } from "@/db";
import { diagrams, diagramVersions } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { generateText } from "ai";
import {
    getModelClient,
    getEffectiveModel,
    getDiagramModelConfig,
    getDiagramFallbackModel,
    isDiagramModelNotFoundError,
} from "../utils/get_model_client";
import { extractCodebase } from "../../utils/codebase";
import { getAtlarixAppPath } from "../../paths/paths";
import { readSettings } from "../../main/settings";
import { AppChatContext } from "../../lib/schemas";
import { apps } from "@/db/schema";
import { generateFingerprint } from "../../lib/analysis/fingerprint";
import { checkDiagramStaleness, type StalenessCheck } from "../../lib/analysis/staleness";
import { DiagramUpdateStrategy } from "../../lib/diagram/diagram_update_strategy";
import { invalidateBlueprintCache } from "./blueprint_handlers";
import { requireAuthSession, AuthRequiredError } from "../../lib/auth/require_auth_session";

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

            console.log(`[diagram:generate] Created diagram "${input.title}" (ID: ${diagram.id})`);

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
            try {
                await requireAuthSession();
            } catch (e) {
                if (e instanceof AuthRequiredError) {
                    return {
                        success: false,
                        error: "Please sign in to generate diagrams with AI.",
                    };
                }
                throw e;
            }
            console.log(`[diagram:generate-ai] Starting generation for workspace ${workspaceId}`);

            // 1. Get Workspace Path
            const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId));
            if (!app) throw new Error("Workspace not found");

            // Resolve path: absolute (imported) used as-is; relative (legacy) → atlarix-apps/name; new workspaces use absolute path.
            const appPath = getAtlarixAppPath(app.path);
            const settings = readSettings();
            // 2. Extract Codebase Context
            // Use default context settings (empty paths = include all non-ignored)
            const chatContext: AppChatContext = {
                contextPaths: [],
                smartContextAutoIncludes: [],
                excludePaths: []
            };

            console.log(`[diagram:generate-ai] Extracting codebase from ${appPath}`);
            const { formattedOutput } = await extractCodebase({
                appPath,
                chatContext
            });

            // 2b. No code / missing dir → return a minimal "No code found" diagram so UI doesn't spam errors
            const noCode =
                !formattedOutput ||
                formattedOutput.startsWith("# Error:") ||
                formattedOutput.trim().length < 80;
            if (noCode) {
                const placeholderContent = "graph TB\n  A[No code found]\n  B[Add files to generate architecture diagram]\n  A --> B";
                const existingDiagram = await db.query.diagrams.findFirst({
                    where: eq(diagrams.workspaceId, workspaceId),
                });
                if (existingDiagram) {
                    const [updated] = await db
                        .update(diagrams)
                        .set({
                            content: placeholderContent,
                            type: "mermaid",
                            title: "No code found",
                            updatedAt: new Date(),
                            metadata: { focus: "no-code-placeholder" },
                        })
                        .where(eq(diagrams.id, existingDiagram.id))
                        .returning();
                    return {
                        success: true,
                        diagram: updated
                            ? { id: updated.id, content: placeholderContent, type: "mermaid" as const, title: "No code found" }
                            : undefined,
                    };
                }
                const [created] = await db.insert(diagrams).values({
                    workspaceId,
                    type: "mermaid",
                    title: "No code found",
                    content: placeholderContent,
                    metadata: { focus: "no-code-placeholder" },
                }).returning();
                return {
                    success: true,
                    diagram: created
                        ? { id: created.id, content: placeholderContent, type: "mermaid" as const, title: "No code found" }
                        : undefined,
                };
            }

            // 3. Prepare AI Client (uses Auto when ON)
            let modelConfig = getDiagramModelConfig(settings);
            let modelClientResult = await getModelClient(modelConfig, settings);

            // 4. Generate Diagram (retry once with fallback on 404 / model not found)
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

            let result: Awaited<ReturnType<typeof generateText>>;
            try {
                console.log(`[diagram:generate-ai] sending prompt to model ${modelConfig.name}`);
                result = await generateText({
                    model: modelClientResult.modelClient.model,
                    system: systemPrompt,
                    messages: [{ role: 'user', content: userPrompt }],
                });
            } catch (genError) {
                if (isDiagramModelNotFoundError(genError)) {
                    const fallback = getDiagramFallbackModel(settings);
                    if (fallback) {
                        console.warn(`[diagram:generate-ai] Model not found, retrying with fallback: ${fallback.provider}/${fallback.name}`);
                        modelConfig = fallback;
                        modelClientResult = await getModelClient(fallback, settings);
                        result = await generateText({
                            model: modelClientResult.modelClient.model,
                            system: systemPrompt,
                            messages: [{ role: 'user', content: userPrompt }],
                        });
                    } else {
                        throw genError;
                    }
                } else {
                    throw genError;
                }
            }

            // 5. Parse Output
            let content = result.text;
            // distinct mermaid block
            const match = content.match(/```mermaid\n([\s\S]*?)\n```/) || content.match(/```\n([\s\S]*?)\n```/);
            if (match) {
                content = match[1];
            }
            content = content.trim();

            // 5b. Fallback: if AI returned empty or invalid, generate from AppMap
            if (!content || content.length < 10) {
                try {
                    const { extractAppMap } = await import("../../lib/workflow/extractors");
                    const { appMapToMermaid } = await import("../../lib/workflow/app_map_to_mermaid");
                    const appMap = await extractAppMap(appPath);
                    if (appMap && ((appMap.entryPoints?.length ?? 0) > 0 || (appMap.dataSources?.length ?? 0) > 0)) {
                        content = appMapToMermaid(appMap);
                    }
                } catch (e) {
                    console.warn("[diagram:generate-ai] AppMap fallback skipped:", e);
                }
            }

            // 6. Generate fingerprint for staleness tracking
            const fingerprint = await generateFingerprint(appPath);

            // 7. Internal diagram git – capture snapshot + diagram content (storage-based history)
            let diagramGitCommit: string | undefined;
            try {
                const { DiagramGitTracker } = await import("../../lib/diagram/diagram_git_tracker");
                const diagramGit = new DiagramGitTracker(workspaceId);
                diagramGitCommit = await diagramGit.captureSnapshot(appPath, content);
                if (diagramGitCommit) {
                    console.log(`[diagram:generate-ai] Diagram git snapshot: ${diagramGitCommit.slice(0, 7)}`);
                }
            } catch (e) {
                console.warn("[diagram:generate-ai] Diagram git capture skipped:", e);
            }

            // 8. Update existing diagram or create one (one diagram per workspace – no duplicates)
            const existingDiagram = await db.query.diagrams.findFirst({
                where: eq(diagrams.workspaceId, workspaceId),
            });

            let diagram: typeof diagrams.$inferSelect;

            if (existingDiagram) {
                // Save previous content to diagram_versions for in-app history
                await db.insert(diagramVersions).values({
                    diagramId: existingDiagram.id,
                    content: existingDiagram.content,
                    changeDescription: "Regenerated (AI)",
                    trigger: "auto_sync",
                }).catch(() => {});

                const meta = (existingDiagram.metadata as Record<string, unknown>) || {};
                const [updated] = await db
                    .update(diagrams)
                    .set({
                        content,
                        type: "mermaid",
                        title: title || existingDiagram.title || `${app.name} Architecture (AI)`,
                        fingerprintHash: fingerprint.hash,
                        fingerprintData: fingerprint,
                        createdFromFileCount: fingerprint.fileCount,
                        updatedAt: new Date(),
                        metadata: {
                            ...meta,
                            focus: "ai-generated",
                            ...(diagramGitCommit && { diagramGitCommit }),
                        },
                    })
                    .where(eq(diagrams.id, existingDiagram.id))
                    .returning();

                diagram = updated;
                console.log(`[diagram:generate-ai] Updated diagram ${existingDiagram.id}`);
            } else {
                const [created] = await db
                    .insert(diagrams)
                    .values({
                        workspaceId,
                        type: "mermaid",
                        title: title || `${app.name} Architecture (AI)`,
                        content,
                        metadata: {
                            focus: "ai-generated",
                            ...(diagramGitCommit && { diagramGitCommit }),
                        },
                        fingerprintHash: fingerprint.hash,
                        fingerprintData: fingerprint,
                        createdFromFileCount: fingerprint.fileCount,
                    })
                    .returning();

                diagram = created;
                console.log(`[diagram:generate-ai] Created diagram ${diagram.id}`);
            }

            invalidateBlueprintCache(workspaceId);
            return { success: true, diagram };

        } catch (error: unknown) {
            console.error("[diagram:generate-ai] Error:", error);
            let message = error instanceof Error ? error.message : "Unknown error";
            if (isDiagramModelNotFoundError(error)) {
                message = "That model is not available on this provider (e.g. it may have been removed or renamed). Please choose another model in Settings, then try again.";
            } else if (typeof (error as { statusCode?: number })?.statusCode === "number") {
                const code = (error as { statusCode: number }).statusCode;
                if (code === 401) message = "API key invalid or user not found. Check your provider API key in Settings.";
                else if (code >= 400 && code < 500) message = `API error (${code}). Check your API key and model in Settings.`;
            }
            const msgLower = String(message).toLowerCase();
            if (msgLower.includes("user not found") || msgLower.includes("401")) {
                message = "API key invalid or user not found. Check your provider API key in Settings.";
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

            console.log(`[diagram:list] Found ${results.length} diagrams`);

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
            console.log(`[diagram:check-staleness] Checking diagram ${diagramId}`);

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

            // Phase 8: Use only internal diagram git (simple-git snapshot in userData/diagram-git/<workspaceId>).
            // No fallback to project git – we do not use the project's repo for diagram decisions.
            let gitDecision: GitDiagramDecision | undefined;
            const meta = diagram.metadata as { diagramGitCommit?: string } | null | undefined;
            const diagramGitCommit = meta?.diagramGitCommit;
            const workspaceId = diagram.workspaceId;

            if (workspaceId && workspacePath && diagramGitCommit) {
                try {
                    const { DiagramGitTracker } = await import("../../lib/diagram/diagram_git_tracker");
                    const { DiagramUpdateStrategy } = await import("../../lib/diagram/diagram_update_strategy");
                    const diagramGit = new DiagramGitTracker(workspaceId);
                    const changes = await diagramGit.analyzeChanges(workspacePath, diagramGitCommit);
                    const decision = DiagramUpdateStrategy.decideFromChangeAnalysis(changes);
                    if (decision.action !== "none") {
                        gitDecision = {
                            action: decision.action,
                            reason: decision.reason,
                            confidence: decision.confidence,
                            totalFiles: decision.changes.totalFiles,
                            linesAdded: decision.changes.linesAdded,
                            linesDeleted: decision.changes.linesDeleted,
                        };
                        console.log(`[diagram:check-staleness] Diagram git decision: ${decision.action} (${decision.reason})`);
                    }
                } catch (err) {
                    console.warn("[diagram:check-staleness] Diagram git skipped:", err);
                }
            }

            console.log(`[diagram:check-staleness] Result: ${staleness.severity} (${staleness.reason})`);

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
// DIAGRAM:MARK-STALE - Notify renderer that diagram may need refresh (e.g. after codegen)
// ============================================

ipcMain.handle(
    "diagram:mark-stale",
    async (_, { workspaceId }: { workspaceId: number }) => {
        const payload = {
            diagramId: workspaceId,
            isStale: true,
            severity: "moderate" as const,
            reason: "Workflow code was generated. Refresh diagram to reflect changes.",
            recommendation: "suggest-refresh" as const,
        };
        for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send("diagram:staleness-detected", payload);
        }
        return { success: true };
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

            console.log(`[diagram:update] Updated diagram ${id}, saved version`);

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
        console.log(`[diagram:delete] Deleted diagram ${id}`);
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

            console.log(`[diagram:history] Found ${versions.length} versions for diagram ${diagramId}`);

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
// DIAGRAM:HISTORY-FROM-GIT - Storage-based version history (git log)
// ============================================

ipcMain.handle(
    "diagram:history-from-git",
    async (_, { workspaceId, maxCount }: { workspaceId: number; maxCount?: number }) => {
        try {
            const { DiagramGitTracker } = await import("../../lib/diagram/diagram_git_tracker");
            const diagramGit = new DiagramGitTracker(workspaceId);
            const history = await diagramGit.getDiagramHistory(maxCount ?? 50);
            console.log(`[diagram:history-from-git] Found ${history.length} commits for workspace ${workspaceId}`);
            return { success: true, versions: history };
        } catch (error) {
            console.error("[diagram:history-from-git] Error:", error);
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

            console.log(`[diagram:restore] Restored diagram ${diagramId} to version ${versionId}`);

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
            try {
                await requireAuthSession();
            } catch (e) {
                if (e instanceof AuthRequiredError) {
                    return { success: false, error: "Please sign in to regenerate diagrams." };
                }
                throw e;
            }
            console.log(`[diagram:regenerate-background] Regenerating diagram for workspace ${workspaceId}`);

            // 1. Get Workspace Path
            const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId));
            if (!app) {
                console.log(`[diagram:regenerate-background] Workspace not found: ${workspaceId}`);
                return { success: false, error: "Workspace not found" };
            }

            const appPath = getAtlarixAppPath(app.path);
            const settings = readSettings();

            // 2. Extract Codebase Context
            const chatContext: AppChatContext = {
                contextPaths: [],
                smartContextAutoIncludes: [],
                excludePaths: []
            };

            console.log(`[diagram:regenerate-background] Extracting codebase from ${appPath}`);
            const { formattedOutput } = await extractCodebase({
                appPath,
                chatContext
            });

            // 3. Prepare AI Client (uses Auto chain when autoModelRouting is ON)
            const modelConfig = getEffectiveModel(settings);
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

            console.log(`[diagram:regenerate-background] Sending prompt to model ${modelConfig.name}`);
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

                console.log(`[diagram:regenerate-background] Updated diagram ${existingDiagram.id}`);
                invalidateBlueprintCache(workspaceId);
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

                console.log(`[diagram:regenerate-background] Created new diagram ${diagram.id}`);
                invalidateBlueprintCache(workspaceId);
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
