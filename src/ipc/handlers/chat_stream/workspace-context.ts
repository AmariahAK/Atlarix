/**
 * Workspace Context Injector
 * ==========================
 * Injects workspace analysis context into chat system prompts
 * and handles diagram display in RightPanel
 */
import log from 'electron-log';
import {
    analyzeWorkspace,
    generateArchitectureDiagram,
    generateSystemPromptContext,
    getCachedAnalysis,
    setCachedAnalysis,
    getWorkspaceHash,
} from '../../../lib/analysis';

const logger = log.scope('workspace-context');

export interface WorkspaceContext {
    systemPromptAddition: string;
    diagram: string;
    summary: string;
    fromCache: boolean;
}

/**
 * Get workspace context for chat - analyzes workspace and returns
 * context to inject into system prompt + diagram for RightPanel
 */
export async function getWorkspaceContext(
    workspacePath: string
): Promise<WorkspaceContext | null> {
    if (!workspacePath) return null;

    logger.info(`Getting workspace context for: ${workspacePath}`);

    try {
        // Check cache first
        const cached = await getCachedAnalysis(workspacePath);

        if (cached) {
            logger.info('Using cached workspace analysis');
            return {
                systemPromptAddition: cached.systemPromptContext,
                diagram: cached.diagram,
                summary: cached.summary,
                fromCache: true,
            };
        }

        // Cache miss - analyze workspace
        logger.info('Analyzing workspace (cache miss)...');
        const startTime = Date.now();

        const analysis = await analyzeWorkspace(workspacePath);
        const diagram = generateArchitectureDiagram(analysis);
        const systemPromptContext = generateSystemPromptContext(analysis);

        // Generate summary for display
        const summary = `${analysis.language}${analysis.framework ? ` (${analysis.framework})` : ''} project with ${analysis.metadata.totalFiles} files`;

        // Get hash for cache
        const hash = await getWorkspaceHash(workspacePath);

        // Store in cache
        await setCachedAnalysis(
            workspacePath,
            hash,
            analysis,
            diagram,
            summary,
            systemPromptContext
        );

        const elapsed = Date.now() - startTime;
        logger.info(`Workspace analyzed in ${elapsed}ms`);

        return {
            systemPromptAddition: systemPromptContext,
            diagram,
            summary,
            fromCache: false,
        };
    } catch (error) {
        logger.error('Failed to get workspace context:', error);
        return null;
    }
}

/**
 * Pre-warm workspace cache (call on app load or workspace selection)
 */
export async function prewarmWorkspaceCache(workspacePath: string): Promise<void> {
    try {
        const cached = await getCachedAnalysis(workspacePath);
        if (!cached) {
            logger.info(`Pre-warming cache for: ${workspacePath}`);
            await getWorkspaceContext(workspacePath);
        }
    } catch (error) {
        logger.warn('Failed to pre-warm cache:', error);
    }
}
