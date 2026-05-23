/**
 * Diagram Refresh Engine
 * ======================
 * Smart decision logic for when to update diagrams after AI operations.
 * 
 * Key insight: Diagrams power the AI's RAG context - stale diagrams = hallucination.
 * This engine evaluates operations AFTER each prompt sequence completes.
 * 
 * Decision: 'generate' | 'refresh' | 'skip'
 */

import { db } from "../db";
import { diagrams } from "../db/schema";
import { eq } from "drizzle-orm";
import log from "electron-log";

const logger = log.scope("diagram-refresh");

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════

export interface ApprovedOperation {
    type: 'write_file' | 'run_command' | 'delete_file' | 'move_file' |
    'edit_file' | 'replace_code' | 'insert_code' | 'delete_lines';
    path?: string;
    command?: string;
    isNewFile?: boolean;
}

export interface DiagramDecision {
    action: 'generate' | 'refresh' | 'skip';
    reason: string;
    confidence: number; // 0-1
}

interface OperationAnalysis {
    structuralChangeScore: number;
    isProjectScaffold: boolean;
    isMinorBugFix: boolean;
    onlyDependencyChanges: boolean;
    usedSurgicalTools: boolean;
    newFolders: number;
    newFiles: number;
    fileCount: number;
}

// ═══════════════════════════════════════════════════════════
// SCAFFOLD COMMAND DETECTION
// ═══════════════════════════════════════════════════════════

const SCAFFOLD_PATTERNS = [
    /npx\s+create-vite/i,
    /npx\s+create-next-app/i,
    /npx\s+create-react-app/i,
    /npm\s+create\s+vite/i,
    /npm\s+create\s+astro/i,
    /npx\s+create-vue/i,
    /npx\s+sv\s+create/i,           // SvelteKit
    /vue\s+create/i,
    /ng\s+new/i,                     // Angular
    /npx\s+express-generator/i,
    /npx\s+@nestjs\/cli\s+new/i,
    /npx\s+fastify-cli\s+generate/i,
    /flask\s+create/i,
    /rails\s+new/i,
    /django-admin\s+startproject/i,
    /npx\s+create-electron-app/i,
    /npm\s+create\s+tauri-app/i,
    /npx\s+react-native\s+init/i,
    /npx\s+create-expo-app/i,
    /bun\s+init/i,
    /bun\s+create/i,
    /bunx\s+create-expo-app/i,
    /mvn\s+-B\s+archetype:generate/i,
    /gradle\s+init/i,
    /curl\s+.*start\.spring\.io/i,
];

// ═══════════════════════════════════════════════════════════
// ARCHITECTURAL DIRECTORIES
// ═══════════════════════════════════════════════════════════

const ARCHITECTURAL_DIR_PATTERNS = [
    /src\/components/,
    /src\/pages/,
    /src\/routes/,
    /src\/lib/,
    /src\/api/,
    /src\/services/,
    /src\/hooks/,
    /src\/utils/,
    /app\//,                // Next.js app router
    /pages\//,              // Next.js pages router
    /models\//,
    /controllers\//,
    /views\//,
    /middleware\//,
];

// ═══════════════════════════════════════════════════════════
// DEPENDENCY-ONLY FILE PATTERNS
// ═══════════════════════════════════════════════════════════

const DEPENDENCY_FILE_PATTERNS = [
    /package\.json$/,
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
    /requirements\.txt$/,
    /Pipfile\.lock$/,
    /Gemfile\.lock$/,
    /go\.sum$/,
    /Cargo\.lock$/,
];

// ═══════════════════════════════════════════════════════════
// MAIN DECISION FUNCTION
// ═══════════════════════════════════════════════════════════

/**
 * Decide whether to generate, refresh, or skip diagram update.
 * Called AFTER all operations from a user prompt complete.
 */
export async function decideDiagramAction(
    workspaceId: number,
    operations: ApprovedOperation[]
): Promise<DiagramDecision> {
    // No operations = nothing to evaluate
    if (operations.length === 0) {
        return {
            action: 'skip',
            reason: 'No operations executed',
            confidence: 1.0,
        };
    }

    // Check if diagram exists for this workspace
    const existingDiagram = await db.query.diagrams.findFirst({
        where: eq(diagrams.workspaceId, workspaceId),
    });

    // Analyze operations
    const analysis = analyzeOperations(operations);

    logger.log(`[DiagramRefresh] Analysis:`, {
        score: analysis.structuralChangeScore.toFixed(2),
        scaffold: analysis.isProjectScaffold,
        surgical: analysis.usedSurgicalTools,
        newFolders: analysis.newFolders,
        fileCount: analysis.fileCount,
    });

    // CASE 1: No existing diagram
    if (!existingDiagram) {
        // Only generate if we have substantial content
        if (analysis.isProjectScaffold || analysis.fileCount >= 3) {
            return {
                action: 'generate',
                reason: 'First diagram for workspace',
                confidence: 1.0,
            };
        }
        return {
            action: 'skip',
            reason: 'No diagram yet, changes too small to warrant generation',
            confidence: 0.8,
        };
    }

    // CASE 2: Project scaffolding detected
    if (analysis.isProjectScaffold) {
        return {
            action: 'refresh',
            reason: 'Project scaffolding detected (complete structure change)',
            confidence: 1.0,
        };
    }

    // CASE 3: Major structural changes (raised from 0.7 → 0.8 to reduce false refreshes)
    if (analysis.structuralChangeScore >= 0.8) {
        return {
            action: 'refresh',
            reason: `Major structural changes (${analysis.newFolders} new folders, ${analysis.newFiles} new files)`,
            confidence: analysis.structuralChangeScore,
        };
    }

    // CASE 4: Minor bug fix (surgical edit or small change)
    if (analysis.isMinorBugFix) {
        return {
            action: 'skip',
            reason: 'Minor bug fix - diagram still accurate',
            confidence: 0.9,
        };
    }

    // CASE 5: Dependency-only changes
    if (analysis.onlyDependencyChanges) {
        return {
            action: 'skip',
            reason: 'Only dependency/config changes - no structural impact',
            confidence: 0.85,
        };
    }

    // CASE 6: Moderate changes (raised 0.5→0.6, fileCount 3→5 - require more files to refresh)
    if (analysis.structuralChangeScore >= 0.6 && analysis.fileCount >= 5) {
        return {
            action: 'refresh',
            reason: `Moderate changes detected (${analysis.fileCount} files, score: ${analysis.structuralChangeScore.toFixed(2)})`,
            confidence: analysis.structuralChangeScore,
        };
    }

    // DEFAULT: Skip for small changes
    return {
        action: 'skip',
        reason: 'Changes too small to warrant diagram update',
        confidence: 0.8,
    };
}

// ═══════════════════════════════════════════════════════════
// OPERATION ANALYSIS
// ═══════════════════════════════════════════════════════════

/**
 * Analyze operations for structural significance.
 * Returns a score and metadata used for decision.
 */
export function analyzeOperations(operations: ApprovedOperation[]): OperationAnalysis {
    let fileCount = 0;
    let scaffoldCommandDetected = false;
    let onlyDependencyChanges = true;
    let usedSurgicalTools = false;

    const affectedPaths = new Set<string>();
    const createdFolders = new Set<string>();

    for (const op of operations) {
        // Check for scaffold commands
        if (op.type === 'run_command' && op.command) {
            if (SCAFFOLD_PATTERNS.some(pattern => pattern.test(op.command!))) {
                scaffoldCommandDetected = true;
            }
        }

        // Track file operations
        if ((op.type === 'write_file' || op.type === 'delete_file' || op.type === 'move_file') && op.path) {
            fileCount++;
            affectedPaths.add(op.path);

            // Extract folder path
            const lastSlash = op.path.lastIndexOf('/');
            if (lastSlash > 0) {
                const folderPath = op.path.substring(0, lastSlash);
                createdFolders.add(folderPath);
            }

            // Check if not a dependency file
            if (!DEPENDENCY_FILE_PATTERNS.some(pattern => pattern.test(op.path!))) {
                onlyDependencyChanges = false;
            }
        }

        // Track surgical tool usage
        if (op.type === 'edit_file' || op.type === 'replace_code' || op.type === 'insert_code' || op.type === 'delete_lines') {
            usedSurgicalTools = true;
            if (op.path) {
                affectedPaths.add(op.path);
            }
        }
    }

    // Count new folders (folders with files written)
    const newFolders = createdFolders.size;

    // Count files in architectural directories
    let newFiles = 0;
    for (const filePath of affectedPaths) {
        if (ARCHITECTURAL_DIR_PATTERNS.some(pattern => pattern.test(filePath))) {
            newFiles++;
        }
    }

    // Calculate structural change score
    let score = 0;

    // Scaffold = major change
    if (scaffoldCommandDetected) {
        score += 0.6;
    }

    // New folders = new "roads" on the map
    if (newFolders >= 3) {
        score += 0.4;
    } else if (newFolders >= 1) {
        score += 0.2;
    }

    // Many new files in architectural dirs
    if (newFiles >= 5) {
        score += 0.3;
    } else if (newFiles >= 3) {
        score += 0.15;
    }

    // Large batch of files
    if (fileCount >= 10) {
        score += 0.2;
    }

    // REDUCE score if only surgical edits (bug fixes)
    if (usedSurgicalTools && !scaffoldCommandDetected && fileCount <= 3) {
        score = Math.max(0, score - 0.3);
    }

    // Cap at 1.0
    score = Math.min(score, 1.0);

    // Detect minor bug fix pattern (broadened: ≤3 files, surgical or few paths)
    const isMinorBugFix = (
        fileCount <= 3 &&
        newFolders === 0 &&
        !scaffoldCommandDetected &&
        (usedSurgicalTools || affectedPaths.size <= 3)
    );

    return {
        structuralChangeScore: score,
        isProjectScaffold: scaffoldCommandDetected,
        isMinorBugFix,
        onlyDependencyChanges: onlyDependencyChanges && fileCount > 0,
        usedSurgicalTools,
        newFolders,
        newFiles,
        fileCount,
    };
}
