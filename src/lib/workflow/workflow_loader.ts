/**
 * WorkflowLoader - load or infer Atlaflow workflow for a workspace
 * ===============================================================
 * Uses existing inferWorkflowFromProject + GitChangeTracker + diagram metadata.
 *
 * Goal:
 * - Existing projects always get a best-effort workflow (no blank Atlaflow).
 * - Prefer diagram.metadata.workflow when present and not too stale.
 * - Otherwise infer from project and persist to diagram metadata.
 */

import log from "electron-log";
import { db } from "@/db";
import { diagrams } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { GitChangeTracker } from "../diagram/git_change_tracker";
import { inferWorkflowFromProject } from "./project_to_workflow";
import type { AtlaflowWorkflow } from "./atlaflow_converter";

const logger = log.scope("workflow-loader");

export interface WorkflowLoadResult {
  workflow: AtlaflowWorkflow;
  /** Where the workflow came from */
  source: "diagram" | "inferred" | "empty";
  /** Whether the persisted workflow looks stale vs current git state */
  isStale: boolean;
}

class WorkflowLoader {
  /** Load workflow for a workspace, inferring it when missing/outdated. */
  async load(workspaceId: number, workspacePath: string): Promise<WorkflowLoadResult> {
    // 1) Try latest diagram with stored workflow
    const latestDiagram = await this.getLatestDiagram(workspaceId);
    const meta = (latestDiagram?.metadata ?? null) as
      | { workflow?: AtlaflowWorkflow; gitCommit?: string }
      | null;

    const storedWorkflow = meta?.workflow;

    if (storedWorkflow && Array.isArray(storedWorkflow.nodes) && storedWorkflow.nodes.length > 0) {
      const lastCommit = meta?.gitCommit;
      const isStale = await this.isWorkflowStale(workspacePath, lastCommit);

      if (!isStale) {
        return {
          workflow: storedWorkflow,
          source: "diagram",
          isStale: false,
        };
      }

      // Stale → try to re-infer; fall back to stored workflow if inference fails
      logger.log(
        `[WorkflowLoader] Stored workflow looks stale for workspace ${workspaceId}, re-inferring...`,
      );
      const refreshed = await this.inferAndPersist(workspaceId, workspacePath, latestDiagram?.id);
      if (refreshed) {
        return {
          workflow: refreshed,
          source: "inferred",
          isStale: false,
        };
      }

      return {
        workflow: storedWorkflow,
        source: "diagram",
        isStale: true,
      };
    }

    // 2) No stored workflow → infer from project
    logger.log(`[WorkflowLoader] No stored workflow for workspace ${workspaceId}, inferring...`);
    const inferred = await this.inferAndPersist(workspaceId, workspacePath, latestDiagram?.id);

    if (inferred) {
      return {
        workflow: inferred,
        source: "inferred",
        isStale: false,
      };
    }

    // 3) Fallback to empty workflow
    logger.warn(
      `[WorkflowLoader] Failed to infer workflow for workspace ${workspaceId}, returning empty workflow`,
    );
    return {
      workflow: { nodes: [], connections: {} },
      source: "empty",
      isStale: false,
    };
  }

  private async isWorkflowStale(
    workspacePath: string,
    lastCommit?: string,
  ): Promise<boolean> {
    if (!lastCommit) return true;

    try {
      const tracker = new GitChangeTracker(workspacePath);
      if (!(await tracker.isGitRepo())) return false;
      const analysis = await tracker.analyzeChanges(lastCommit);
      // Consider stale if >5% of files changed
      return analysis.changePercentage > 5;
    } catch (err) {
      logger.warn("[WorkflowLoader] Failed to check workflow staleness:", err);
      return false;
    }
  }

  private async inferAndPersist(
    workspaceId: number,
    workspacePath: string,
    existingDiagramId?: number,
  ): Promise<AtlaflowWorkflow | null> {
    try {
      const inferred = await inferWorkflowFromProject(workspacePath);
      if (!inferred || !Array.isArray(inferred.nodes) || inferred.nodes.length === 0) {
        return null;
      }

      const tracker = new GitChangeTracker(workspacePath);
      const gitCommit = await tracker.getCurrentCommitHash();

      // Persist into latest diagram metadata if we have one
      if (existingDiagramId) {
        const [current] = await db
          .select()
          .from(diagrams)
          .where(eq(diagrams.id, existingDiagramId));

        if (current) {
          const meta = (current.metadata ?? null) as Record<string, unknown> | null;
          const nextMeta: Record<string, unknown> = {
            ...(meta ?? {}),
            workflow: inferred,
            ...(gitCommit && { gitCommit }),
          };

          await db
            .update(diagrams)
            .set({ metadata: nextMeta })
            .where(eq(diagrams.id, existingDiagramId));
        }
      }

      return inferred;
    } catch (err) {
      logger.warn("[WorkflowLoader] inferAndPersist failed:", err);
      return null;
    }
  }

  private async getLatestDiagram(workspaceId: number) {
    try {
      const rows = await db
        .select()
        .from(diagrams)
        .where(eq(diagrams.workspaceId, workspaceId))
        .orderBy(desc(diagrams.updatedAt))
        .limit(1);
      return rows[0] ?? null;
    } catch (err) {
      logger.warn("[WorkflowLoader] getLatestDiagram failed:", err);
      return null;
    }
  }
}

export const workflowLoader = new WorkflowLoader();

