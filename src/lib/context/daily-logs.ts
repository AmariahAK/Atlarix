/**
 * Daily Logs - Diagram-First Context System
 * ==========================================
 * Provides AI-generated micro-changelog and selective tool logging
 * to replace chat history as context source.
 */
import { db } from "../../db";
import { dailyLogs, apps } from "../../db/schema";
import { eq, and, gte, lt } from "drizzle-orm";
import log from "electron-log";

const logger = log.scope("daily-logs");

// State-changing tools that should be logged
const STATE_CHANGING_TOOLS = [
    "write_file",
    "write_files",
    "execute_command",
    "run_command",
    "delete_file",
    "apply_proposal",
    "create_directory",
    "rename_file",
    "move_file",
];

// Tools to skip (noise reduction)
const SKIP_TOOLS = [
    "read_file",
    "list_files",
    "search_code",
    "find_file",
    "web_search",
    "get_current_time",
    "get_diagram",
];

export interface SignificantAction {
    tool: string;
    target?: string;
    summary: string;
    timestamp: string; // ISO string
}

// In-memory buffer for current session's actions
const sessionActions: Map<number, SignificantAction[]> = new Map();

/**
 * Check if a tool call should be logged
 */
export function shouldLogToolCall(toolName: string): boolean {
    return STATE_CHANGING_TOOLS.includes(toolName);
}

/**
 * Log a significant tool action for a workspace
 */
export function logToolAction(
    workspaceId: number,
    action: {
        tool: string;
        target?: string;
        summary: string;
    }
): void {
    if (!shouldLogToolCall(action.tool)) {
        return;
    }

    const actions = sessionActions.get(workspaceId) || [];
    actions.push({
        ...action,
        timestamp: new Date().toISOString(),
    });
    sessionActions.set(workspaceId, actions);

    logger.debug(`Logged action for workspace ${workspaceId}: ${action.tool}`);
}

/**
 * Get today's actions for a workspace
 */
export function getSessionActions(workspaceId: number): SignificantAction[] {
    return sessionActions.get(workspaceId) || [];
}

/**
 * Clear session actions for a workspace (after saving to DB)
 */
export function clearSessionActions(workspaceId: number): void {
    sessionActions.delete(workspaceId);
}

/**
 * Get start of day as Date
 */
function getStartOfDay(date: Date = new Date()): Date {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    return start;
}

/**
 * Check if daily log exists for today
 */
export async function hasTodaysLog(workspaceId: number): Promise<boolean> {
    const today = getStartOfDay();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const existing = await db.query.dailyLogs.findFirst({
        where: and(
            eq(dailyLogs.workspaceId, workspaceId),
            gte(dailyLogs.date, today),
            lt(dailyLogs.date, tomorrow)
        ),
    });

    return !!existing;
}

/**
 * Get the last activity date for a workspace
 */
export async function getLastActivityDate(
    workspaceId: number
): Promise<Date | null> {
    const lastLog = await db.query.dailyLogs.findFirst({
        where: eq(dailyLogs.workspaceId, workspaceId),
        orderBy: (logs, { desc }) => [desc(logs.date)],
    });

    return lastLog?.date || null;
}

/**
 * Check if we need to generate yesterday's log
 * (Call on first message of the day)
 */
export async function shouldGenerateDailyLog(
    workspaceId: number
): Promise<{ shouldGenerate: boolean; forDate: Date | null }> {
    const lastActivity = await getLastActivityDate(workspaceId);
    const today = getStartOfDay();

    if (!lastActivity) {
        // No previous activity
        return { shouldGenerate: false, forDate: null };
    }

    const lastActivityDay = getStartOfDay(lastActivity);

    // If last activity was before today, generate log for that day
    if (lastActivityDay < today) {
        return { shouldGenerate: true, forDate: lastActivityDay };
    }

    return { shouldGenerate: false, forDate: null };
}

/**
 * Save daily log to database
 */
export async function saveDailyLog(
    workspaceId: number,
    date: Date,
    data: {
        microChanges: string[];
        significantActions: SignificantAction[];
        filesTouched: string[];
        diagramChanged: boolean;
    }
): Promise<void> {
    await db.insert(dailyLogs).values({
        workspaceId,
        date,
        microChanges: data.microChanges,
        significantActions: data.significantActions,
        filesTouched: data.filesTouched,
        diagramChanged: data.diagramChanged,
    });

    logger.info(`Saved daily log for workspace ${workspaceId} on ${date.toISOString()}`);
}

/**
 * Get recent daily logs for context building
 */
export async function getRecentDailyLogs(
    workspaceId: number,
    days: number = 7
): Promise<typeof dailyLogs.$inferSelect[]> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const logs = await db.query.dailyLogs.findMany({
        where: and(
            eq(dailyLogs.workspaceId, workspaceId),
            gte(dailyLogs.date, cutoffDate)
        ),
        orderBy: (logs, { desc }) => [desc(logs.date)],
    });

    return logs;
}

/**
 * Build context string from recent daily logs
 * (For injection into AI prompts)
 */
export async function buildDailyLogsContext(
    workspaceId: number,
    days: number = 7
): Promise<string> {
    const logs = await getRecentDailyLogs(workspaceId, days);

    if (logs.length === 0) {
        return "";
    }

    const sections = logs.map((log) => {
        const dateStr = log.date.toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
        });

        const changes = log.microChanges?.length
            ? log.microChanges.map((c) => `  - ${c}`).join("\n")
            : "  - No significant changes";

        return `**${dateStr}**\n${changes}`;
    });

    return `## Recent Activity (Last ${days} Days)\n\n${sections.join("\n\n")}`;
}
