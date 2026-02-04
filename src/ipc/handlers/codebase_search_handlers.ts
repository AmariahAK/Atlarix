/**
 * Codebase Search Handlers
 * =======================
 * IPC handlers for user-initiated codebase search (semantic search).
 * Used by CodebaseSearchBox with Recent Searches.
 */

import { ipcMain } from "electron";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { eq } from "drizzle-orm";
import { resolveAppPath } from "../../paths/paths";
import { ToolRegistry } from "../../lib/tools/registry";

export function registerCodebaseSearchHandlers() {
    ipcMain.handle(
        "search-codebase",
        async (
            _,
            params: { query: string; appId: number; maxResults?: number }
        ) => {
            const { query, appId, maxResults = 15 } = params;
            if (!query?.trim() || !appId) {
                return { success: false, error: "Missing query or appId" };
            }

            try {
                const app = await db.query.apps.findFirst({
                    where: eq(apps.id, appId),
                    columns: { path: true },
                });
                if (!app) {
                    return { success: false, error: "Workspace not found" };
                }

                const workspacePath = resolveAppPath(app.path);
                const result = await ToolRegistry.execute("semantic_search", {
                    query: query.trim(),
                    workspace: workspacePath,
                    max_results: maxResults,
                });

                if (!result.success) {
                    return { success: false, error: result.error };
                }

                return {
                    success: true,
                    query: result.query,
                    results: result.results ?? [],
                    formatted_with_context: result.formatted_with_context,
                    total_matches: result.total_matches ?? 0,
                    files_searched: result.files_searched,
                    workspace_path: result.workspace_path,
                };
            } catch (err) {
                console.error("[search-codebase]", err);
                return {
                    success: false,
                    error: err instanceof Error ? err.message : "Search failed",
                };
            }
        }
    );
}
