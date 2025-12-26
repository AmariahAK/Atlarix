/**
 * Diagram IPC Handlers
 * ====================
 * Handle diagram CRUD operations, version history, and export
 */

import { ipcMain } from "electron";
import { db } from "@/db";
import { diagrams, diagramVersions } from "@/db/schema";
import { eq, desc } from "drizzle-orm";

// ============================================
// TYPES
// ============================================

export interface DiagramInput {
    workspaceId?: number;
    chatId?: number;
    type: "mermaid" | "plantuml" | "architecture" | "sequence" | "class" | "flowchart";
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
