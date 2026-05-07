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
    type WorkspaceAnalysis,
} from '../../../lib/analysis';

const logger = log.scope('workspace-context');

export interface WorkspaceContext {
    systemPromptAddition: string;
    diagram: string;
    summary: string;
    fromCache: boolean;
}

const workspaceAnalysisInFlight = new Map<string, Promise<WorkspaceAnalysis>>();

/**
 * Get workspace context for chat - analyzes workspace and returns
 * context to inject into system prompt + diagram for RightPanel
 */
export async function getWorkspaceContext(
    workspacePath: string
): Promise<WorkspaceContext | null> {
    if (!workspacePath || typeof workspacePath !== 'string') {
        logger.warn('Invalid workspace path received');
        return null;
    }

    logger.info(`Getting workspace context for: ${workspacePath}`);

    try {
        // v7.1.2: Check memory pressure before expensive analysis
        const { isUnderMemoryPressure } = await import('@/constants/settings_constants');
        if (isUnderMemoryPressure()) {
            logger.warn('Memory pressure — returning minimal workspace context');
            return {
                systemPromptAddition: '',
                diagram: '',
                summary: 'Workspace (analysis skipped due to memory pressure)',
                fromCache: false,
            };
        }

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

        // v8.0.1: In-flight deduplication — prevents parallel analyzeWorkspace calls
        // from OOM-ing the app on large workspaces
        const existing = workspaceAnalysisInFlight.get(workspacePath);
        if (existing) {
            logger.log('[getWorkspaceContext] deduplicating in-flight analysis for', workspacePath);
            const analysis = await existing;
            const diagram = generateArchitectureDiagram(analysis);
            const systemPromptContext = generateSystemPromptContext(analysis);
            const summary = `${analysis.language}${analysis.framework ? ` (${analysis.framework})` : ''} project with ${analysis.metadata.totalFiles} files`;
            return {
                systemPromptAddition: systemPromptContext,
                diagram,
                summary,
                fromCache: false,
            };
        }

        // Cache miss - analyze workspace
        logger.info('Analyzing workspace (cache miss)...');
        const startTime = Date.now();

        const analysisPromise = analyzeWorkspace(workspacePath);
        workspaceAnalysisInFlight.set(workspacePath, analysisPromise);
        try {
            const analysis = await analysisPromise;
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
        } finally {
            workspaceAnalysisInFlight.delete(workspacePath);
        }
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
