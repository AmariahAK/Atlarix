/**
 * Atlarix Memory Tools - Database-Backed
 * =======================================
 * Tools for recalling workspace activity and history
 * Uses dailyLogs and `.atlarix/snapshots/` diagram timeline
 * 
 * MIGRATED from file-based storage to SQLite database
 * Aligns with Diagram-First Context System
 */

import {
    ToolRegistry,
    ToolCategory,
    createParameters,
    stringParam,
} from "./registry";
import { db } from "../../db";
import { dailyLogs, apps } from "../../db/schema";
import { eq, desc, and, gte, sql } from "drizzle-orm";
import { getAtlarixAppPath } from "../../paths/paths";
import { listDiagramSnapshotTimeline } from "../snapshot/snapshot-manager";

// ═══════════════════════════════════════════════════════════
// MEMORY RECALL - Query dailyLogs + snapshot timeline
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "recall_memory",
    description:
        "Recall recent workspace activity, changes, and architectural evolution. Queries the database for daily activity logs and diagram version history.",
    category: ToolCategory.MEMORY,
    cost: 1,
    requiresWorkspace: true,
    isCore: false,
    isReadOnly: true, // Safe for Ask mode
    parameters: createParameters(
        {
            workspaceId: {
                type: "number",
                description: "Workspace ID to recall activity for",
            },
            timeRange: stringParam(
                "Time range: 'today', 'week', 'month', or 'all' (default: 'week')"
            ),
            limit: {
                type: "number",
                description: "Maximum number of results (default: 10)",
            },
        },
        ["workspaceId"]
    ),
    handler: async ({ workspaceId, timeRange = "week", limit = 10 }) => {
        try {
            // Calculate date threshold
            const now = new Date();
            const thresholds: Record<string, Date> = {
                today: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
                week: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
                month: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
                all: new Date(0),
            };
            const threshold = thresholds[timeRange] || thresholds.week;

            // Query daily logs
            const logs = await db
                .select({
                    date: dailyLogs.date,
                    microChanges: dailyLogs.microChanges,
                    significantActions: dailyLogs.significantActions,
                    filesTouched: dailyLogs.filesTouched,
                    diagramChanged: dailyLogs.diagramChanged,
                })
                .from(dailyLogs)
                .where(
                    and(
                        eq(dailyLogs.workspaceId, workspaceId),
                        gte(dailyLogs.date, threshold)
                    )
                )
                .orderBy(desc(dailyLogs.date))
                .limit(limit);

            const [app] = await db
                .select()
                .from(apps)
                .where(eq(apps.id, workspaceId))
                .limit(1);

            let diagramChanges: { timestamp: Date; label: string }[] = [];
            if (app) {
                const timeline = await listDiagramSnapshotTimeline(getAtlarixAppPath(app.path));
                diagramChanges = timeline
                    .filter((e) => new Date(e.timestamp) >= threshold)
                    .map((e) => ({
                        timestamp: new Date(e.timestamp),
                        label: e.isInitial
                            ? "Initial diagram snapshot"
                            : e.prompt?.trim() || `Snapshot ${e.turnId}`,
                    }))
                    .slice(0, limit);
            }

            // Format response
            if (logs.length === 0 && diagramChanges.length === 0) {
                return `📚 No activity found for workspace ${workspaceId} in the last ${timeRange}.\n\nThis workspace may be new or hasn't had any tracked changes yet.`;
            }

            let result = `📚 **Workspace Activity (${timeRange})**\n\n`;
            result += `Found ${logs.length} day(s) of activity and ${diagramChanges.length} architectural change(s).\n\n`;

            // Recent activity
            if (logs.length > 0) {
                result += `## Daily Activity\n`;
                logs.forEach((log) => {
                    const dateStr = log.date ? new Date(log.date).toISOString().split("T")[0] : "Unknown";
                    result += `\n### ${dateStr}\n`;

                    if (log.microChanges && log.microChanges.length > 0) {
                        result += `**Changes:**\n`;
                        log.microChanges.forEach((change: string) => {
                            result += `- ${change}\n`;
                        });
                    }

                    if (log.filesTouched && log.filesTouched.length > 0) {
                        result += `**Files:** ${log.filesTouched.slice(0, 5).join(", ")}`;
                        if (log.filesTouched.length > 5) {
                            result += ` (+${log.filesTouched.length - 5} more)`;
                        }
                        result += `\n`;
                    }

                    if (log.diagramChanged) {
                        result += `🔄 Architecture diagram was updated\n`;
                    }
                });
            }

            // Architectural evolution
            if (diagramChanges.length > 0) {
                result += `\n## Architectural Evolution\n`;
                diagramChanges.forEach((change) => {
                    const timeStr = change.timestamp.toLocaleDateString();
                    result += `\n- **${timeStr}**: ${change.label}\n`;
                });
            }

            return result;
        } catch (error) {
            throw new Error(`Failed to recall memory: ${error}`);
        }
    },
});

// ═══════════════════════════════════════════════════════════
// SEARCH MEMORY - Search database tables
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "search_memory",
    description:
        "Search workspace history for specific topics, files, or changes. Searches through daily logs and diagram summaries.",
    category: ToolCategory.MEMORY,
    cost: 1,
    requiresWorkspace: true,
    isCore: false,
    isReadOnly: true, // Safe for Ask mode
    parameters: createParameters(
        {
            workspaceId: {
                type: "number",
                description: "Workspace ID to search",
            },
            query: stringParam("Search query (topic, file name, or keyword)"),
            limit: {
                type: "number",
                description: "Maximum number of results (default: 20)",
            },
        },
        ["workspaceId", "query"]
    ),
    handler: async ({ workspaceId, query, limit = 20 }) => {
        try {
            const searchTerm = `%${query.toLowerCase()}%`;
            const results: {
                type: string;
                date: string;
                content: string;
                files?: string[];
            }[] = [];

            // Search in daily logs - microChanges (check if any change contains the query)
            const logs = await db
                .select({
                    date: dailyLogs.date,
                    microChanges: dailyLogs.microChanges,
                    filesTouched: dailyLogs.filesTouched,
                })
                .from(dailyLogs)
                .where(eq(dailyLogs.workspaceId, workspaceId))
                .orderBy(desc(dailyLogs.date))
                .limit(100); // Get more, filter in-memory

            // Filter logs that match the query
            logs.forEach((log) => {
                const changes = log.microChanges || [];
                const matchingChanges = changes.filter((c: string) =>
                    c.toLowerCase().includes(query.toLowerCase())
                );

                const files = log.filesTouched || [];
                const matchingFiles = files.filter((f: string) =>
                    f.toLowerCase().includes(query.toLowerCase())
                );

                if (matchingChanges.length > 0 || matchingFiles.length > 0) {
                    const dateStr = log.date ? new Date(log.date).toISOString().split("T")[0] : "Unknown";
                    results.push({
                        type: "activity",
                        date: dateStr,
                        content: matchingChanges.length > 0
                            ? matchingChanges.join("; ")
                            : `Files: ${matchingFiles.join(", ")}`,
                        files: matchingFiles.length > 0 ? matchingFiles : files,
                    });
                }
            });

            const [appRow] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);
            if (appRow) {
                const timeline = await listDiagramSnapshotTimeline(getAtlarixAppPath(appRow.path));
                const q = query.toLowerCase();
                timeline.forEach((e) => {
                    const searchText = `${e.prompt || ""} ${e.turnId}`.toLowerCase();
                    if (searchText.includes(q)) {
                        const dateStr = new Date(e.timestamp).toLocaleDateString();
                        results.push({
                            type: "architecture",
                            date: dateStr,
                            content: e.prompt?.trim() || `Snapshot ${e.turnId}`,
                        });
                    }
                });
            }

            // Format response
            if (results.length === 0) {
                return `🔍 No results found for: "${query}"\n\nTry different keywords or check if the workspace has tracked activity.`;
            }

            let response = `🔍 **Search Results for "${query}"**\n\n`;
            response += `Found ${results.length} match(es)\n\n`;

            // Group by type
            const activityResults = results.filter((r) => r.type === "activity").slice(0, limit);
            const archResults = results.filter((r) => r.type === "architecture").slice(0, limit);

            if (activityResults.length > 0) {
                response += `## Daily Activity Matches\n`;
                activityResults.forEach((r) => {
                    response += `- **${r.date}**: ${r.content}\n`;
                });
            }

            if (archResults.length > 0) {
                response += `\n## Architecture Change Matches\n`;
                archResults.forEach((r) => {
                    response += `- **${r.date}**: ${r.content}\n`;
                });
            }

            return response;
        } catch (error) {
            throw new Error(`Failed to search memory: ${error}`);
        }
    },
});

// NOTE: save_learning tool has been REMOVED
// AI now auto-generates dailyLogs entries via the Diagram-First Context System
// Manual memory saving is no longer needed
