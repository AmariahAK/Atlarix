/**
 * Atlarix Memory Tools
 * ====================
 * Session memory (recall/search of activity timeline) and durable
 * project memory (snapshots + key/value).
 *
 * Absorbs: memory-tools + project-memory-tools (kept as distinct tools
 * because they operate on different subsystems).
 */

import {
    ToolRegistry,
    ToolCategory,
    createParameters,
    stringParam,
} from "./registry";
import { db } from "../../db";
import { dailyLogs, apps } from "../../db/schema";
import { eq, desc, and, gte } from "drizzle-orm";
import { getAtlarixAppPath } from "../../paths/paths";
import { listDiagramSnapshotTimeline } from "../snapshot/snapshot-manager";
import {
    listProjectSnapshots,
    listProjectMemoryKeys,
    upsertProjectMemoryKey,
} from "@/lib/project-memory/service";

// ═══════════════════════════════════════════════════════════
// SESSION MEMORY (`memory` tool — recall/search)
// ═══════════════════════════════════════════════════════════

async function runRecall(args: {
    workspaceId: number;
    timeRange?: string;
    limit?: number;
}) {
    const { workspaceId } = args;
    const timeRange = args.timeRange ?? "week";
    const limit = args.limit ?? 10;
    const now = new Date();
    const thresholds: Record<string, Date> = {
        today: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
        week: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        month: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
        all: new Date(0),
    };
    const threshold = thresholds[timeRange] || thresholds.week;

    const logs = await db
        .select({
            date: dailyLogs.date,
            microChanges: dailyLogs.microChanges,
            significantActions: dailyLogs.significantActions,
            filesTouched: dailyLogs.filesTouched,
            diagramChanged: dailyLogs.diagramChanged,
        })
        .from(dailyLogs)
        .where(and(eq(dailyLogs.workspaceId, workspaceId), gte(dailyLogs.date, threshold)))
        .orderBy(desc(dailyLogs.date))
        .limit(limit);

    const [app] = await db.select().from(apps).where(eq(apps.id, workspaceId)).limit(1);

    let diagramChanges: { timestamp: Date; label: string }[] = [];
    if (app) {
        const timeline = await listDiagramSnapshotTimeline(getAtlarixAppPath(app.path));
        diagramChanges = timeline
            .filter((e) => new Date(e.timestamp) >= threshold)
            .map((e) => ({
                timestamp: new Date(e.timestamp),
                label: e.isInitial ? "Initial diagram snapshot" : e.prompt?.trim() || `Snapshot ${e.turnId}`,
            }))
            .slice(0, limit);
    }

    if (logs.length === 0 && diagramChanges.length === 0) {
        return `📚 No activity found for workspace ${workspaceId} in the last ${timeRange}.`;
    }

    let result = `📚 **Workspace Activity (${timeRange})**\n\n`;
    result += `Found ${logs.length} day(s) of activity and ${diagramChanges.length} architectural change(s).\n\n`;

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
                if (log.filesTouched.length > 5) result += ` (+${log.filesTouched.length - 5} more)`;
                result += `\n`;
            }
            if (log.diagramChanged) result += `🔄 Architecture diagram was updated\n`;
        });
    }

    if (diagramChanges.length > 0) {
        result += `\n## Architectural Evolution\n`;
        diagramChanges.forEach((change) => {
            const timeStr = change.timestamp.toLocaleDateString();
            result += `\n- **${timeStr}**: ${change.label}\n`;
        });
    }
    return result;
}

async function runSearch(args: { workspaceId: number; query: string; limit?: number }) {
    const { workspaceId, query } = args;
    const limit = args.limit ?? 20;
    const results: { type: string; date: string; content: string; files?: string[] }[] = [];

    const logs = await db
        .select({
            date: dailyLogs.date,
            microChanges: dailyLogs.microChanges,
            filesTouched: dailyLogs.filesTouched,
        })
        .from(dailyLogs)
        .where(eq(dailyLogs.workspaceId, workspaceId))
        .orderBy(desc(dailyLogs.date))
        .limit(100);

    logs.forEach((log) => {
        const changes = log.microChanges || [];
        const matchingChanges = changes.filter((c: string) => c.toLowerCase().includes(query.toLowerCase()));
        const files = log.filesTouched || [];
        const matchingFiles = files.filter((f: string) => f.toLowerCase().includes(query.toLowerCase()));
        if (matchingChanges.length > 0 || matchingFiles.length > 0) {
            const dateStr = log.date ? new Date(log.date).toISOString().split("T")[0] : "Unknown";
            results.push({
                type: "activity",
                date: dateStr,
                content: matchingChanges.length > 0 ? matchingChanges.join("; ") : `Files: ${matchingFiles.join(", ")}`,
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

    if (results.length === 0) {
        return `🔍 No results found for: "${query}"\n\nTry different keywords or check if the workspace has tracked activity.`;
    }

    let response = `🔍 **Search Results for "${query}"**\n\n`;
    response += `Found ${results.length} match(es)\n\n`;

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
}

ToolRegistry.register({
    name: "memory",
    description:
        "Query session-scoped workspace memory (daily activity + diagram snapshot timeline). " +
        "operation=recall lists recent activity by timeRange; operation=search runs a keyword query.",
    category: ToolCategory.MEMORY,
    cost: 1,
    requiresWorkspace: true,
    isCore: false,
    isReadOnly: true,
    parameters: createParameters(
        {
            operation: {
                type: "string",
                enum: ["recall", "search"],
                description: "recall=list recent activity; search=keyword search across activity.",
            },
            workspaceId: {
                type: "number",
                description: "Workspace ID to operate on.",
            },
            query: stringParam("(search) Keyword query."),
            timeRange: stringParam("(recall) Time range: today | week (default) | month | all."),
            limit: {
                type: "number",
                description: "Maximum results (recall default 10, search default 20).",
            },
        },
        ["operation", "workspaceId"]
    ),
    handler: async (args: {
        operation: "recall" | "search";
        workspaceId: number;
        query?: string;
        timeRange?: string;
        limit?: number;
    }) => {
        try {
            if (args.operation === "recall") {
                return await runRecall({ workspaceId: args.workspaceId, timeRange: args.timeRange, limit: args.limit });
            }
            if (args.operation === "search") {
                if (!args.query) {
                    return `⚠️ memory({ operation: "search" }) requires a query.`;
                }
                return await runSearch({ workspaceId: args.workspaceId, query: args.query, limit: args.limit });
            }
            return `⚠️ Unknown operation: ${args.operation}. Use "recall" or "search".`;
        } catch (error) {
            throw new Error(`memory tool failed: ${error}`);
        }
    },
});

// ═══════════════════════════════════════════════════════════
// PROJECT MEMORY (snapshots + key/value)
// ═══════════════════════════════════════════════════════════

ToolRegistry.register({
    name: "get_project_history",
    description:
        "List recent project snapshots (plan + diagram checkpoints) and stored memory keys for this workspace. To request a revert, pass revert_to: { snapshotId, reason } (user approval) instead of a separate tool.",
    category: ToolCategory.MEMORY,
    cost: 1,
    requiresWorkspace: true,
    isCore: false,
    isReadOnly: false,
    allowInAskMode: true,
    parameters: createParameters(
        {
            workspaceId: { type: "number", description: "Workspace ID" },
            limit: { type: "number", description: "Max snapshots (default 20)", required: false },
            revert_to: {
                type: "object",
                description:
                    "Optional: request revert to a snapshot (requires user approval). Use snapshot id from a prior snapshots list.",
                properties: {
                    snapshotId: { type: "number", description: "Snapshot id from snapshots list" },
                    reason: { type: "string", description: "Short reason for revert" },
                },
            },
        },
        ["workspaceId"],
    ),
    handler: async ({
        workspaceId,
        limit,
        revert_to,
    }: {
        workspaceId: number;
        limit?: number;
        revert_to?: { snapshotId?: number; reason?: string };
    }) => {
        if (
            revert_to &&
            typeof revert_to.snapshotId === "number" &&
            revert_to.reason != null &&
            String(revert_to.reason).trim().length > 0
        ) {
            const { getProjectSnapshotRow } = await import("@/lib/project-memory/service");
            const row = await getProjectSnapshotRow(revert_to.snapshotId, workspaceId);
            if (!row) {
                return { success: false, error: "Snapshot not found for this workspace" };
            }
            const reason = String(revert_to.reason);
            return {
                __permission_required: true,
                operation: "revert_project_snapshot",
                preview: {
                    snapshotId: revert_to.snapshotId,
                    label: `Revert to snapshot #${revert_to.snapshotId}: ${reason.slice(0, 120)}`,
                    planExcerpt: row.planMd ? row.planMd.slice(0, 400) : undefined,
                },
                reasoning: reason,
            };
        }

        const lim = limit != null && limit > 0 ? Math.min(limit, 50) : 20;
        const snapshots = await listProjectSnapshots(workspaceId, lim);
        const memory = await listProjectMemoryKeys(workspaceId);
        return {
            success: true,
            snapshots,
            memoryKeys: memory.map((m) => ({ key: m.key, valuePreview: m.value.slice(0, 300) })),
        };
    },
});

ToolRegistry.register({
    name: "set_project_memory",
    description:
        "Store a durable key/value fact for this workspace (shown in future session system prompts). Values are truncated; prefer concise facts.",
    category: ToolCategory.MEMORY,
    cost: 1,
    requiresWorkspace: true,
    isCore: false,
    isReadOnly: false,
    parameters: createParameters(
        {
            workspaceId: { type: "number", description: "Workspace ID" },
            key: stringParam("Short key (e.g. preferred_stack, auth_model)"),
            value: stringParam("Value text"),
        },
        ["workspaceId", "key", "value"],
    ),
    handler: async ({ workspaceId, key, value }: { workspaceId: number; key: string; value: string }) => {
        await upsertProjectMemoryKey(workspaceId, key, value);
        return { success: true, key, message: "Stored in project_memory" };
    },
});
