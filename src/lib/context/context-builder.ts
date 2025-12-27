/**
 * Diagram-First Context Builder
 * =============================
 * Builds AI context from:
 * 1. Architecture diagram (~2-3K tokens)
 * 2. Daily logs (~500 tokens for 7 days)
 * 3. Recent session actions (~200 tokens)
 * 
 * Total: ~3-4K tokens (vs 168K+ from extractCodebase)
 */
import log from "electron-log";
import { getWorkspaceContext } from "../../ipc/handlers/chat_stream/workspace-context";
import { buildDailyLogsContext, getSessionActions } from "./daily-logs";

const logger = log.scope("context-builder");

export interface DiagramContext {
    diagram: string;
    summary: string;
    dailyLogs: string;
    recentActions: string;
    fullContext: string;
    estimatedTokens: number;
}

/**
 * Build lightweight context for AI prompts
 * Replaces the 168K token extractCodebase() approach
 */
export async function buildDiagramContext(
    workspacePath: string,
    workspaceId?: number
): Promise<DiagramContext | null> {
    logger.info(`Building diagram context for: ${workspacePath}`);
    const startTime = Date.now();

    try {
        // 1. Get diagram context (already cached)
        const wsContext = await getWorkspaceContext(workspacePath);
        if (!wsContext) {
            logger.warn("No workspace context available");
            return null;
        }

        // 2. Get daily logs (if workspace ID provided)
        let dailyLogsSection = "";
        if (workspaceId) {
            dailyLogsSection = await buildDailyLogsContext(workspaceId, 7);
        }

        // 3. Get recent session actions
        let recentActionsSection = "";
        if (workspaceId) {
            const actions = getSessionActions(workspaceId);
            if (actions.length > 0) {
                const actionLines = actions
                    .slice(-10) // Last 10 actions
                    .map((a) => `- ${a.tool}: ${a.summary || a.target || "completed"}`)
                    .join("\n");
                recentActionsSection = `## Recent Actions (This Session)\n${actionLines}`;
            }
        }

        // 4. Assemble full context
        const sections = [
            wsContext.systemPromptAddition, // Diagram + summary
            dailyLogsSection,
            recentActionsSection,
        ].filter(Boolean);

        const fullContext = sections.join("\n\n");

        // Estimate tokens (~4 chars per token)
        const estimatedTokens = Math.ceil(fullContext.length / 4);

        const elapsed = Date.now() - startTime;
        logger.info(`Context built in ${elapsed}ms: ~${estimatedTokens} tokens`);

        return {
            diagram: wsContext.diagram,
            summary: wsContext.summary,
            dailyLogs: dailyLogsSection,
            recentActions: recentActionsSection,
            fullContext,
            estimatedTokens,
        };
    } catch (error) {
        logger.error("Failed to build diagram context:", error);
        return null;
    }
}

/**
 * Get a minimal context for token-constrained scenarios
 */
export async function getMinimalContext(
    workspacePath: string
): Promise<string> {
    const wsContext = await getWorkspaceContext(workspacePath);
    return wsContext?.systemPromptAddition || "";
}
