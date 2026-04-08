/**
 * Diagram staleness from `.atlarix/snapshot_hashes.json` vs current workspace hashes.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { StalenessCheck } from "../analysis/staleness";
import { atlasDir, computeWorkspaceFileHashes } from "./workspace-hash";
import type { ChangeAnalysis, FileChange } from "../diagram/diagram_update_strategy";
import { DiagramUpdateStrategy, type DiagramDecision } from "../diagram/diagram_update_strategy";

const SNAPSHOT_HASHES_FILE = "snapshot_hashes.json";

export function snapshotHashesJsonPath(workspacePath: string): string {
    return path.join(atlasDir(workspacePath), SNAPSHOT_HASHES_FILE);
}

export async function readSnapshotHashesFile(workspacePath: string): Promise<Record<string, string> | null> {
    try {
        const raw = await fs.readFile(snapshotHashesJsonPath(workspacePath), "utf8");
        const j = JSON.parse(raw) as Record<string, string>;
        return typeof j === "object" && j !== null ? j : null;
    } catch {
        return null;
    }
}

/** Diff stored vs current hashes into a ChangeAnalysis for DiagramUpdateStrategy. */
export function changeAnalysisFromHashMaps(
    stored: Record<string, string> | null,
    current: Record<string, string>,
): ChangeAnalysis {
    const changes: FileChange[] = [];
    const storedKeys = stored ? new Set(Object.keys(stored)) : new Set<string>();
    const currentKeys = new Set(Object.keys(current));

    for (const p of currentKeys) {
        if (!storedKeys.has(p)) {
            changes.push({ path: p, type: "A", insertions: 1, deletions: 0, binary: false });
        } else if (stored && stored[p] !== current[p]) {
            changes.push({ path: p, type: "M", insertions: 1, deletions: 1, binary: false });
        }
    }
    for (const p of storedKeys) {
        if (!currentKeys.has(p)) {
            changes.push({ path: p, type: "D", insertions: 0, deletions: 1, binary: false });
        }
    }

    const totalFiles = changes.length;
    const filesAdded = changes.filter((c) => c.type === "A").length;
    const filesModified = changes.filter((c) => c.type === "M").length;
    const filesDeleted = changes.filter((c) => c.type === "D").length;
    const linesAdded = changes.reduce((s, c) => s + c.insertions, 0);
    const linesDeleted = changes.reduce((s, c) => s + c.deletions, 0);
    const projectFileCount = Math.max(Object.keys(current).length, 1);
    const changePercentage = (totalFiles / projectFileCount) * 100;
    const isArchitecturalChange =
        filesAdded >= 3 ||
        filesDeleted >= 2 ||
        changes.some((c) => /package\.json$/i.test(c.path)) ||
        changePercentage > 20;

    return {
        totalFiles,
        filesAdded,
        filesModified,
        filesDeleted,
        linesAdded,
        linesDeleted,
        changePercentage,
        isArchitecturalChange,
        changes,
    };
}

/**
 * Staleness when comparing last saved hashes (DB or file) to current workspace.
 * Missing baseline → stale (no snapshot yet after unified snapshots).
 */
export async function checkSnapshotStaleness(
    workspacePath: string,
    storedHashes: Record<string, string> | null | undefined,
): Promise<{ staleness: StalenessCheck; snapshotDecision: DiagramDecision | undefined }> {
    const current = await computeWorkspaceFileHashes(workspacePath);
    const effectiveStored = storedHashes && Object.keys(storedHashes).length > 0
        ? storedHashes
        : await readSnapshotHashesFile(workspacePath);

    if (!effectiveStored || Object.keys(effectiveStored).length === 0) {
        return {
            staleness: {
                isStale: true,
                severity: "moderate",
                reason: "No snapshot hash baseline — refresh diagram to capture workspace state",
                changes: {
                    filesAdded: 0,
                    filesRemoved: 0,
                    fileCountChange: Object.keys(current).length,
                    percentChange: 100,
                },
                recommendation: "suggest-refresh",
            },
            snapshotDecision: undefined,
        };
    }

    const analysis = changeAnalysisFromHashMaps(effectiveStored, current);
    const decision = DiagramUpdateStrategy.decideFromChangeAnalysis(analysis);

    const changed = analysis.totalFiles;
    const pct = Math.min(100, changed > 0 ? (changed / Math.max(Object.keys(effectiveStored).length, 1)) * 100 : 0);

    const staleness: StalenessCheck = {
        isStale: changed > 0,
        severity: changed === 0 ? "none" : pct < 10 ? "minor" : pct < 30 ? "moderate" : "major",
        reason:
            changed === 0
                ? "Workspace matches last diagram snapshot hashes"
                : `${changed} file(s) changed since last diagram snapshot`,
        changes: {
            filesAdded: analysis.filesAdded,
            filesRemoved: analysis.filesDeleted,
            fileCountChange: analysis.filesAdded - analysis.filesDeleted,
            percentChange: pct,
        },
        recommendation:
            decision.action === "regenerate"
                ? "force-refresh"
                : decision.action === "update"
                  ? "suggest-refresh"
                  : "keep",
    };

    return { staleness, snapshotDecision: changed > 0 ? decision : undefined };
}
