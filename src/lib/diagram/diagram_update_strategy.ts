/**
 * DiagramUpdateStrategy - Decide update vs regenerate from git-based change analysis
 * ===================================================================================
 * Thresholds: <5% = skip (bug fixes), 5–15% = update, 15–30% = update with caution,
 * >30% or architectural = regenerate.
 */

import { GitChangeTracker, ChangeAnalysis } from "./git_change_tracker";
import log from "electron-log";

const logger = log.scope("diagram-update-strategy");

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════

export type DiagramAction = "none" | "update" | "regenerate";

export interface DiagramDecision {
    action: DiagramAction;
    reason: string;
    confidence: number; // 0–100
    changes: ChangeAnalysis;
}

// ═══════════════════════════════════════════════════════════
// STRATEGY
// ═══════════════════════════════════════════════════════════

export class DiagramUpdateStrategy {
    private readonly MINOR_THRESHOLD = 5;   // < 5% = skip (bug fix)
    private readonly MODERATE_THRESHOLD = 15; // 5–15% = update
    private readonly MAJOR_THRESHOLD = 30;   // > 30% = regenerate

    constructor(private workspacePath: string) {}

    /**
     * Decide diagram action from a precomputed ChangeAnalysis (e.g. from DiagramGitTracker).
     * Use this when using internal diagram git (Phase 8) so the same thresholds apply.
     */
    static decideFromChangeAnalysis(changes: ChangeAnalysis): DiagramDecision {
        const strategy = new DiagramUpdateStrategy("");
        return strategy.decideFromChanges(changes);
    }

    /**
     * Decide diagram action from project git analysis (optional; diagram staleness uses internal diagram git only).
     */
    async decideDiagramAction(lastDiagramCommit?: string): Promise<DiagramDecision> {
        const tracker = new GitChangeTracker(this.workspacePath);
        const changes = await tracker.analyzeChanges(lastDiagramCommit);
        return this.decideFromChanges(changes);
    }

    private decideFromChanges(changes: ChangeAnalysis): DiagramDecision {

        // No changes
        if (changes.totalFiles === 0) {
            return {
                action: "none",
                reason: "No file changes detected",
                confidence: 100,
                changes,
            };
        }

        // Minor: bug fixes / typos
        if (this.isMinorChange(changes)) {
            return {
                action: "none",
                reason: `Minor change (${changes.changePercentage.toFixed(1)}% of codebase). Likely bug fixes or refactoring.`,
                confidence: 90,
                changes,
            };
        }

        // Architectural → regenerate
        if (changes.isArchitecturalChange) {
            return {
                action: "regenerate",
                reason: "Architectural change detected (e.g. new dependencies, folders, or core files)",
                confidence: 95,
                changes,
            };
        }

        // Major % → regenerate
        if (changes.changePercentage >= this.MAJOR_THRESHOLD) {
            return {
                action: "regenerate",
                reason: `Large change (${changes.changePercentage.toFixed(1)}%). Full regeneration recommended.`,
                confidence: 90,
                changes,
            };
        }

        // Moderate: update
        if (changes.changePercentage >= this.MINOR_THRESHOLD && changes.changePercentage < this.MODERATE_THRESHOLD) {
            return {
                action: "update",
                reason: `Moderate change (${changes.changePercentage.toFixed(1)}%). Update existing diagram.`,
                confidence: 85,
                changes,
            };
        }

        // 15–30%: update with caution
        if (changes.changePercentage < this.MAJOR_THRESHOLD) {
            return {
                action: "update",
                reason: `Significant change (${changes.changePercentage.toFixed(1)}%). Update with new nodes.`,
                confidence: 75,
                changes,
            };
        }

        return {
            action: "regenerate",
            reason: `Change (${changes.changePercentage.toFixed(1)}%). Regenerating for safety.`,
            confidence: 70,
            changes,
        };
    }

    private isMinorChange(changes: ChangeAnalysis): boolean {
        return (
            changes.changePercentage < this.MINOR_THRESHOLD &&
            !changes.isArchitecturalChange &&
            changes.filesAdded === 0 &&
            changes.filesDeleted === 0
        );
    }

    /**
     * Generate AI prompt for diagram update (not full regeneration)
     */
    generateUpdatePrompt(changes: ChangeAnalysis): string {
        const fileList = changes.changes
            .slice(0, 50)
            .map((c) => `${c.type}: ${c.path} (+${c.insertions}/-${c.deletions})`)
            .join("\n");
        return `
Update the existing architecture diagram based on these changes:

## Changes Summary
- Files modified: ${changes.filesModified}
- Files added: ${changes.filesAdded}
- Files deleted: ${changes.filesDeleted}
- Lines added: ${changes.linesAdded}
- Lines deleted: ${changes.linesDeleted}

## Detailed Changes
${fileList}

## Task
Modify the existing diagram to reflect these changes: add nodes for new files/modules, update existing nodes if responsibilities changed, remove nodes for deleted files. Keep the overall architecture structure intact. Use update_diagram (or modify_diagram) rather than generating a brand new diagram.
`.trim();
    }
}
