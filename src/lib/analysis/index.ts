/**
 * Workspace Analysis Module
 * =========================
 * Exports all analysis utilities for workspace intelligence
 */
export {
    analyzeWorkspace,
    type WorkspaceAnalysis,
    type AnalyzedFile,
    type Cluster,
    type Dependency,
} from './workspace-analyzer';

export {
    generateArchitectureDiagram,
    generateTextSummary,
    generateSystemPromptContext,
} from './diagram-generator';

export {
    getCachedAnalysis,
    setCachedAnalysis,
    getWorkspaceHash,
    invalidateCache,
    clearAllCaches,
    getCacheStats,
} from './workspace-cache';

export {
    parseWithTreeSitter,
    isTreeSitterAvailable,
    type ParsedFileResult,
} from './treesitter-parser';
