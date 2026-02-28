/**
 * PIVOT analysis IPC — run SonarQube, Semgrep, SCIP and return findings.
 */

import { ipcMain } from "electron";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getAtlarixAppPath } from "@/paths/paths";
import { fetchSonarIssues, type SonarIssue } from "@/lib/pivot/analysis/sonar";
import { runSemgrepScan, type SemgrepFinding } from "@/lib/pivot/analysis/semgrep";
import { getScipSymbols } from "@/lib/pivot/analysis/scip";
import log from "electron-log";

const logger = log.scope("pivot_analysis");

export interface AnalysisResult {
  sonar: { success: boolean; issues?: SonarIssue[]; error?: string };
  semgrep: { success: boolean; findings?: SemgrepFinding[]; error?: string };
  scip: { success: boolean; symbols?: unknown[]; error?: string };
}

function getSonarConfigFromEnv(): { baseUrl: string; token: string; projectKey?: string } | null {
  const baseUrl = process.env.SONAR_URL ?? process.env.SONAR_HOST_URL;
  const token = process.env.SONAR_TOKEN;
  if (!baseUrl?.trim() || !token?.trim()) return null;
  return {
    baseUrl: baseUrl.trim(),
    token: token.trim(),
    projectKey: process.env.SONAR_PROJECT_KEY?.trim(),
  };
}

export function registerPivotAnalysisHandlers(): void {
  ipcMain.handle(
    "pivot:run-analysis",
    async (
      _,
      { workspaceId, projectKey }: { workspaceId: number; projectKey?: string }
    ): Promise<{ success: boolean; result?: AnalysisResult; error?: string }> => {
      try {
        const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
        if (!app) return { success: false, error: "Workspace not found" };
        const workspacePath = getAtlarixAppPath(app.path);

        const sonarConfig = getSonarConfigFromEnv();
        const sonar = await fetchSonarIssues(sonarConfig, projectKey);

        const semgrep = await runSemgrepScan(workspacePath);

        const scip = await getScipSymbols(workspacePath);

        const result: AnalysisResult = { sonar, semgrep, scip };
        logger.debug("pivot:run-analysis", {
          workspaceId,
          sonar: sonar.success ? sonar.issues?.length : 0,
          semgrep: semgrep.success ? semgrep.findings?.length : 0,
        });
        return { success: true, result };
      } catch (error) {
        logger.error("pivot:run-analysis error:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  );
}
