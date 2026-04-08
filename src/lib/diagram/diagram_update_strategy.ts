/**
 * DiagramUpdateStrategy — thresholds for update vs regenerate from change analysis
 * (hash diff, git-less).
 */


// ═══════════════════════════════════════════════════════════
// TYPES (ex-git; used by snapshot staleness + strategy)
// ═══════════════════════════════════════════════════════════

export type FileChangeType = "A" | "M" | "D" | "R";

export interface FileChange {
    path: string;
    type: FileChangeType;
    insertions: number;
    deletions: number;
    binary: boolean;
}

export interface ChangeAnalysis {
    totalFiles: number;
    filesAdded: number;
    filesModified: number;
    filesDeleted: number;
    linesAdded: number;
    linesDeleted: number;
    changePercentage: number;
    isArchitecturalChange: boolean;
    changes: FileChange[];
}

export type DiagramAction = "none" | "update" | "regenerate";

export interface DiagramDecision {
    action: DiagramAction;
    reason: string;
    confidence: number;
    changes: ChangeAnalysis;
}

// ═══════════════════════════════════════════════════════════
// STRATEGY
// ═══════════════════════════════════════════════════════════

export class DiagramUpdateStrategy {
    private readonly MINOR_THRESHOLD = 5;
    private readonly MODERATE_THRESHOLD = 15;
    private readonly MAJOR_THRESHOLD = 30;

    constructor(_workspacePath: string) {}

    static decideFromChangeAnalysis(changes: ChangeAnalysis): DiagramDecision {
        const strategy = new DiagramUpdateStrategy("");
        return strategy.decideFromChanges(changes);
    }

    private decideFromChanges(changes: ChangeAnalysis): DiagramDecision {
        if (changes.totalFiles === 0) {
            return {
                action: "none",
                reason: "No file changes detected",
                confidence: 100,
                changes,
            };
        }

        if (this.isMinorChange(changes)) {
            return {
                action: "none",
                reason: `Minor change (${changes.changePercentage.toFixed(1)}% of codebase). Likely bug fixes or refactoring.`,
                confidence: 90,
                changes,
            };
        }

        if (changes.isArchitecturalChange) {
            return {
                action: "regenerate",
                reason: "Architectural change detected (e.g. new dependencies, folders, or core files)",
                confidence: 95,
                changes,
            };
        }

        if (changes.changePercentage >= this.MAJOR_THRESHOLD) {
            return {
                action: "regenerate",
                reason: `Large change (${changes.changePercentage.toFixed(1)}%). Full regeneration recommended.`,
                confidence: 90,
                changes,
            };
        }

        if (changes.changePercentage >= this.MINOR_THRESHOLD && changes.changePercentage < this.MODERATE_THRESHOLD) {
            return {
                action: "update",
                reason: `Moderate change (${changes.changePercentage.toFixed(1)}%). Update existing diagram.`,
                confidence: 85,
                changes,
            };
        }

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
