/**
 * Diagram IPC Handlers
 * ====================
 * Handle diagram CRUD operations, version history, and export
 */

import { ipcMain, BrowserWindow } from "electron";
import { db } from "@/db";
import { diagrams } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { generateText } from "ai";
import {
    getModelClient,
    getEffectiveModel,
    getDiagramModelConfig,
    getDiagramFallbackModel,
    isDiagramModelNotFoundError,
} from "../utils/get_model_client";
import { extractCodebaseCached } from "../../utils/codebase";
import { getAtlarixAppPath } from "../../paths/paths";
import { readSettings } from "../../main/settings";
import { AppChatContext } from "../../lib/schemas";
import { apps } from "@/db/schema";
import { checkSnapshotStaleness, type StalenessCheck } from "../../lib/snapshot/staleness";
import { persistWorkspaceSnapshotHashes } from "../../lib/snapshot/snapshot-manager";
// Pass 7: invalidateBlueprintCache removed with the Blueprint subsystem.
import { requireAuthSession, AuthRequiredError } from "../../lib/auth/require_auth_session";
import { normalizeDiagramAiOutput } from "../../lib/normalizeDiagramMermaid";
import { DIAGRAM_MERMAID_CRITICAL_RULES } from "@/lib/diagramMermaidPromptRules";
import { runDiagramRegenerateBackground } from "./diagram_regenerate_background";

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

function toClientDiagram<T extends { diagramType?: string; [key: string]: unknown }>(diagram: T): Omit<T, "diagramType"> & { type: string } {
    const { diagramType, ...rest } = diagram;
    return {
        ...rest,
        type: typeof diagramType === "string" && diagramType.trim() ? diagramType : "mermaid",
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
                    diagramType: input.type,
                    title: input.title,
                    content: input.content,
                    metadata: input.metadata,
                })
                .returning();

            return {
                success: true,
                diagram: toClientDiagram(diagram),
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
            // Panel-driven generation: allowed in all work modes (ask, plan, build, debug, review, agent).

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

            const { formattedOutput } = await extractCodebaseCached({
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
                            diagramType: "mermaid",
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
                    diagramType: "mermaid",
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
- Group related components in subgraphs.

${DIAGRAM_MERMAID_CRITICAL_RULES}

- Mermaid node IDs (left side): Use safe identifiers only (letters/numbers/underscores). If you need special characters like &, put them in the quoted label, not the node ID.
- Subgraphs: use explicit id and bracket title, e.g. subgraph clientTier [Client Tier].
- Prefer no style/classDef/class (theme-safe). If coloring nodes, the directive is lowercase style (never Style).
- Start the diagram body with graph or flowchart as the first line; do not prefix with a standalone line that is only the word mermaid (breaks detection).
- Avoid linkStyle default and long CSS on edges; prefer simple --> links when possible.`;

            const userPrompt = `Generate an architecture diagram for this project:

${formattedOutput.substring(0, 50000)} // Limit context to 50k chars to avoid huge costs/errors if project is massive`;

            let result: Awaited<ReturnType<typeof generateText>>;
            try {
                result = await generateText({
                    model: modelClientResult.modelClient.model,
                    system: systemPrompt,
                    messages: [{ role: 'user', content: userPrompt }],
                });
            } catch (genError) {
                if (isDiagramModelNotFoundError(genError)) {
                    const fallback = getDiagramFallbackModel(settings);
                    if (fallback) {
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
            let content = normalizeDiagramAiOutput(result.text);

            // 5b. Fallback: if AI returned empty or invalid, generate from AppMap
            if (!content || content.length < 10) {
                try {
                    const { extractAppMap } = await import("../../lib/workflow/extractors");
                    const { appMapToMermaid } = await import("../../lib/workflow/app_map_to_mermaid");
                    const appMap = await extractAppMap(appPath);
                    if (appMap && ((appMap.entryPoints?.length ?? 0) > 0 || (appMap.dataSources?.length ?? 0) > 0)) {
                        content = appMapToMermaid(appMap);
                    }
                } catch {
                    /* AppMap fallback optional */
                }
            }

            // 6. Update existing diagram or create one (one diagram per workspace – no duplicates)
            const existingDiagram = await db.query.diagrams.findFirst({
                where: eq(diagrams.workspaceId, workspaceId),
            });

            let diagram: typeof diagrams.$inferSelect;

            if (existingDiagram) {
                const meta = { ...((existingDiagram.metadata as Record<string, unknown>) || {}) };
                delete meta.diagramGitCommit;

                const [updated] = await db
                    .update(diagrams)
                    .set({
                        content,
                        diagramType: "mermaid",
                        title: title || existingDiagram.title || `${app.name} Architecture (AI)`,
                        updatedAt: new Date(),
                        metadata: {
                            ...meta,
                            focus: "ai-generated",
                        },
                    })
                    .where(eq(diagrams.id, existingDiagram.id))
                    .returning();

                diagram = updated;
            } else {
                const [created] = await db
                    .insert(diagrams)
                    .values({
                        workspaceId,
                        diagramType: "mermaid",
                        title: title || `${app.name} Architecture (AI)`,
                        content,
                        metadata: {
                            focus: "ai-generated",
                        },
                    })
                    .returning();

                diagram = created;
            }

            try {
                await persistWorkspaceSnapshotHashes(diagram.id, appPath);
            } catch {
                /* snapshot persistence optional */
            }

            return { success: true, diagram: toClientDiagram(diagram) };

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

            // Defensive: older versions and some flows created multiple rows per workspace.
            // For UI consistency, only return the most-recent diagram per workspace.
            const seenWorkspaceIds = new Set<number | null>();
            const deduped = results.filter((d) => {
                const wid = (d as { workspaceId: number | null }).workspaceId ?? null;
                if (seenWorkspaceIds.has(wid)) return false;
                seenWorkspaceIds.add(wid);
                return true;
            });

            return {
                success: true,
                diagrams: deduped.map(toClientDiagram),
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
        action?: "none";
        staleness?: StalenessCheck;
        gitDecision?: GitDiagramDecision;
        error?: string;
    }> => {
        try {
            if (readSettings().selectedChatMode === "ask") {
                return {
                    success: true,
                    action: "none",
                    staleness: {
                        isStale: false,
                        severity: "none",
                        reason: "Ask mode: diagram auto-refresh is disabled",
                        changes: {
                            filesAdded: 0,
                            filesRemoved: 0,
                            fileCountChange: 0,
                            percentChange: 0,
                        },
                        recommendation: "keep",
                    },
                };
            }

            const [diagram] = await db
                .select()
                .from(diagrams)
                .where(eq(diagrams.id, diagramId));

            if (!diagram) {
                return { success: false, error: "Diagram not found" };
            }

            let gitDecision: GitDiagramDecision | undefined;
            try {
                const { staleness, snapshotDecision } = await checkSnapshotStaleness(
                    workspacePath,
                    diagram.lastSnapshotHashes ?? undefined,
                );
                if (snapshotDecision && snapshotDecision.action !== "none") {
                    const d = snapshotDecision;
                    gitDecision = {
                        action: d.action,
                        reason: d.reason,
                        confidence: d.confidence,
                        totalFiles: d.changes.totalFiles,
                        linesAdded: d.changes.linesAdded,
                        linesDeleted: d.changes.linesDeleted,
                    };
                }
                return { success: true, staleness, gitDecision };
            } catch {
                return {
                    success: true,
                    staleness: {
                        isStale: false,
                        severity: "none" as const,
                        reason: "Staleness check unavailable",
                        changes: { filesAdded: 0, filesRemoved: 0, fileCountChange: 0, percentChange: 0 },
                        recommendation: "keep" as const,
                    },
                    gitDecision: undefined,
                };
            }
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

            return { success: true, diagram: toClientDiagram(diagram) };
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

            // Update diagram with new content
            const [updated] = await db
                .update(diagrams)
                .set({
                    content,
                    updatedAt: new Date(),
                })
                .where(eq(diagrams.id, id))
                .returning();

            if (updated?.workspaceId) {
                const [app] = await db.select().from(apps).where(eq(apps.id, updated.workspaceId));
                if (app) {
                    try {
                        await persistWorkspaceSnapshotHashes(id, getAtlarixAppPath(app.path));
                    } catch {
                        /* snapshot persistence optional */
                    }
                }
            }

            return { success: true, diagram: updated ? toClientDiagram(updated) : updated };
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
                type: diagram.diagramType,
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

ipcMain.handle("diagram:regenerate-background", async (_, { workspaceId }: { workspaceId: number }) => {
    return runDiagramRegenerateBackground(workspaceId);
});
