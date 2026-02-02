/**
 * DiagramManager - Static utility class for diagram generation
 * ============================================================
 * Handles cold starts, deduplication, and generation tracking.
 * 
 * Key responsibilities:
 * - Track in-progress diagram generation to prevent duplicate calls
 * - Provide waiting mechanism for cold start scenarios
 * - Manage initial diagram generation for new workspaces
 * - Handle AI-triggered diagram regeneration
 */

import { db } from "@/db";
import { diagrams, apps } from "@/db/schema";
import { eq } from "drizzle-orm";
import { generateText } from "ai";
import { getModelClient } from "@/ipc/utils/get_model_client";
import { extractCodebase } from "@/utils/codebase";
import { readSettings } from "@/main/settings";
import { generateFingerprint } from "./analysis/fingerprint";
import type { AppChatContext } from "./schemas";
import log from "electron-log";

const logger = log.scope("DiagramManager");

// Type for diagram record from database
interface Diagram {
    id: number;
    workspaceId: number | null;
    type: string;
    title: string;
    content: string;
    metadata: unknown;
    fingerprintHash: string | null;
    createdAt: Date;
    updatedAt: Date;
}

// Options for regenerating diagrams
interface RegenerateOptions {
    focusComponents?: string[];
    context?: string;
}

/**
 * DiagramManager - Static utility class for diagram generation state
 */
export class DiagramManager {
    // Track which workspaces are currently generating diagrams
    private static generatingWorkspaces = new Set<number>();

    // Store promises for in-progress generations (for deduplication and waiting)
    private static generationPromises = new Map<number, Promise<Diagram>>();

    /**
     * Check if any diagram exists for a workspace
     */
    static async hasAnyDiagram(workspaceId: number): Promise<boolean> {
        try {
            const existingDiagram = await db.query.diagrams.findFirst({
                where: eq(diagrams.workspaceId, workspaceId),
            });
            return !!existingDiagram;
        } catch (error) {
            logger.error(`[hasAnyDiagram] Error checking diagram for workspace ${workspaceId}:`, error);
            return false;
        }
    }

    /**
     * Check if generation is currently in progress for a workspace
     */
    static isGenerating(workspaceId: number): boolean {
        return this.generatingWorkspaces.has(workspaceId);
    }

    /**
     * Wait for in-progress diagram generation to complete
     * Returns the generated diagram or null if timeout/error
     */
    static async waitForGeneration(workspaceId: number, timeoutMs: number = 30000): Promise<Diagram | null> {
        const existingPromise = this.generationPromises.get(workspaceId);

        if (!existingPromise) {
            logger.debug(`[waitForGeneration] No generation in progress for workspace ${workspaceId}`);
            return null;
        }

        logger.info(`[waitForGeneration] Waiting for diagram generation for workspace ${workspaceId} (timeout: ${timeoutMs}ms)`);

        try {
            // Race between the existing promise and a timeout
            const result = await Promise.race([
                existingPromise,
                new Promise<null>((_, reject) =>
                    setTimeout(() => reject(new Error('Diagram generation timeout')), timeoutMs)
                ),
            ]);
            return result;
        } catch (error) {
            logger.warn(`[waitForGeneration] Timeout or error waiting for diagram:`, error);
            return null;
        }
    }

    /**
     * Generate initial diagram for a workspace
     * Includes deduplication to prevent multiple simultaneous generations
     */
    static async generateInitialDiagram(workspaceId: number, appPath: string): Promise<Diagram> {
        // Check if already generating (deduplication)
        const existingPromise = this.generationPromises.get(workspaceId);
        if (existingPromise) {
            logger.info(`[generateInitialDiagram] Reusing existing generation promise for workspace ${workspaceId}`);
            return existingPromise;
        }

        // Track that we're generating
        this.generatingWorkspaces.add(workspaceId);
        logger.info(`[generateInitialDiagram] Starting diagram generation for workspace ${workspaceId}`);

        // Create and store the generation promise
        const generationPromise = this._generateDiagram(workspaceId, appPath);
        this.generationPromises.set(workspaceId, generationPromise);

        try {
            const result = await generationPromise;
            logger.info(`[generateInitialDiagram] Diagram generated successfully for workspace ${workspaceId}`);
            return result;
        } finally {
            // Cleanup tracking state
            this.generatingWorkspaces.delete(workspaceId);
            this.generationPromises.delete(workspaceId);
        }
    }

    /**
     * Regenerate diagram for a workspace
     * Called when AI update_diagram tool is approved
     */
    static async regenerateForWorkspace(
        workspaceId: number,
        options?: RegenerateOptions
    ): Promise<Diagram> {
        // Get workspace path
        const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId));
        if (!app) {
            throw new Error(`Workspace not found: ${workspaceId}`);
        }

        logger.info(`[regenerateForWorkspace] Regenerating diagram for workspace ${workspaceId}`, {
            focusComponents: options?.focusComponents,
            context: options?.context,
        });

        // Track generation
        this.generatingWorkspaces.add(workspaceId);

        try {
            // Generate with optional context from AI
            const diagram = await this._generateDiagram(workspaceId, app.path, options);
            return diagram;
        } finally {
            this.generatingWorkspaces.delete(workspaceId);
        }
    }

    /**
     * Internal method to generate a diagram
     * Handles the actual AI generation and database persistence
     */
    private static async _generateDiagram(
        workspaceId: number,
        appPath: string,
        options?: RegenerateOptions
    ): Promise<Diagram> {
        // Get workspace info
        const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId));
        if (!app) {
            throw new Error(`Workspace not found: ${workspaceId}`);
        }

        const settings = readSettings();

        // Extract codebase context
        const chatContext: AppChatContext = {
            contextPaths: [],
            smartContextAutoIncludes: [],
            excludePaths: [],
        };

        logger.debug(`[_generateDiagram] Extracting codebase from ${appPath}`);
        const { formattedOutput } = await extractCodebase({
            appPath,
            chatContext,
        });

        // Prepare AI client
        const modelConfig = settings.selectedModel;
        const { modelClient } = await getModelClient(modelConfig, settings);

        // Build system prompt with optional focus from AI
        let systemPrompt = `You are an expert software architect.
Analyze the provided codebase and generate a Mermaid.js diagram that best represents the high-level architecture.
Focus on:
- Major components/modules
- Data flow
- Relationships between files
- External dependencies (if obvious)

Requirements:
- Return ONLY the mermaid code block.
- Use 'graph TB' or 'graph LR'.
- Do NOT use 'classDiagram' unless specifically appropriate for OOP analysis.
- Keep the diagram clean and readable (avoid too many nodes).
- Group related components in subgraphs.`;

        // Add focus context if provided by AI
        if (options?.focusComponents?.length) {
            systemPrompt += `\n\nFocus especially on these components that were recently modified: ${options.focusComponents.join(', ')}`;
        }
        if (options?.context) {
            systemPrompt += `\n\nContext for this update: ${options.context}`;
        }

        const userPrompt = `Generate an architecture diagram for this project:\n\n${formattedOutput.substring(0, 50000)}`;

        logger.debug(`[_generateDiagram] Sending prompt to model ${modelConfig.name}`);
        const result = await generateText({
            model: modelClient.model,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
        });

        // Parse output
        let content = result.text;
        const match = content.match(/```mermaid\n([\s\S]*?)\n```/) || content.match(/```\n([\s\S]*?)\n```/);
        if (match) {
            content = match[1];
        }
        content = content.trim();

        // Generate fingerprint for staleness tracking
        const fingerprint = await generateFingerprint(appPath);

        // Git commit for diagram update strategy (update vs regenerate)
        let gitCommit: string | undefined;
        let updateType: "regenerate" | "update" | undefined = "regenerate";
        try {
            const { GitChangeTracker } = await import("./diagram/git_change_tracker");
            const tracker = new GitChangeTracker(appPath);
            if (await tracker.isGitRepo()) {
                gitCommit = await tracker.getCurrentCommitHash();
            }
        } catch (e) {
            logger.warn("[_generateDiagram] Git commit capture skipped:", e);
        }

        // Infer workflow from project (Diagram tab Workflow mode)
        let workflowMetadata: { nodes?: unknown[]; connections?: unknown } | undefined;
        try {
            const { inferWorkflowForWorkspace } = await import("./workflow/project_to_workflow");
            const inferred = await inferWorkflowForWorkspace(appPath);
            if (inferred) {
                workflowMetadata = { nodes: inferred.nodes, connections: inferred.connections };
            }
        } catch (e) {
            logger.warn("[_generateDiagram] Workflow inference skipped:", e);
        }

        // Check for existing diagram and update or create
        const existingDiagram = await db.query.diagrams.findFirst({
            where: eq(diagrams.workspaceId, workspaceId),
        });

        let diagram: Diagram;

        if (existingDiagram) {
            // Update existing diagram
            const meta = (existingDiagram.metadata as Record<string, unknown>) || {};
            const updatePayload: Record<string, unknown> = {
                content,
                fingerprintHash: fingerprint.hash,
                fingerprintData: fingerprint,
                createdFromFileCount: fingerprint.fileCount,
                updatedAt: new Date(),
                metadata: {
                    ...meta,
                    ...(workflowMetadata && { workflow: workflowMetadata }),
                    ...(gitCommit && { gitCommit }),
                    updateType,
                },
            };
            const [updated] = await db
                .update(diagrams)
                .set(updatePayload)
                .where(eq(diagrams.id, existingDiagram.id))
                .returning();

            diagram = updated as Diagram;
            logger.info(`[_generateDiagram] Updated diagram ${existingDiagram.id}`);
        } else {
            // Create new diagram
            const [created] = await db
                .insert(diagrams)
                .values({
                    workspaceId,
                    type: "mermaid",
                    title: `${app.name} Architecture`,
                    content,
                    metadata: {
                        focus: "auto-generated",
                        ...(workflowMetadata && { workflow: workflowMetadata }),
                        ...(gitCommit && { gitCommit }),
                        updateType,
                    },
                    fingerprintHash: fingerprint.hash,
                    fingerprintData: fingerprint,
                    createdFromFileCount: fingerprint.fileCount,
                })
                .returning();

            diagram = created as Diagram;
            logger.info(`[_generateDiagram] Created new diagram ${created.id}`);
        }

        return diagram;
    }

    /**
     * Clear all tracking state (useful for testing or cleanup)
     */
    static clearState(): void {
        this.generatingWorkspaces.clear();
        this.generationPromises.clear();
        logger.debug('[clearState] Cleared all DiagramManager state');
    }
}
