/**
 * Session Memory Manager
 * ======================
 * In-memory rolling buffer of recent exchanges for session continuity.
 * Prevents AI from losing context within a chat session.
 *
 * Phase 5: Raised limits for better task focus (was 5 exchanges, 300/500 chars).
 *
 * Design:
 * - Keeps last 10 exchanges (user + assistant pairs)
 * - Truncates messages to control token usage (generous limits)
 * - Per-chat session (cleared when chat ends)
 * - No disk persistence (ephemeral by design)
 */

import log from "electron-log";

const logger = log.scope("session-memory");

// ═══════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════

interface SessionExchange {
    user: string;        // User message (truncated)
    assistant: string;   // Assistant response (truncated)
    timestamp: number;
    toolsUsed?: string[]; // Optional: track which tools were called
}

interface SessionContext {
    exchanges: SessionExchange[];
    currentTask?: string;  // What we're currently working on
    errors: string[];      // Errors encountered
}

// ═══════════════════════════════════════════════════════════
// SESSION MEMORY CLASS
// ═══════════════════════════════════════════════════════════

export class SessionMemory {
    private context: SessionContext;
    private maxExchanges: number;
    private maxUserChars: number;
    private maxAssistantChars: number;

    constructor(options?: {
        maxExchanges?: number;
        maxUserChars?: number;
        maxAssistantChars?: number;
    }) {
        this.maxExchanges = options?.maxExchanges ?? 7;
        this.maxUserChars = options?.maxUserChars ?? 800;
        this.maxAssistantChars = options?.maxAssistantChars ?? 1500;

        this.context = {
            exchanges: [],
            errors: [],
        };

        logger.log(`SessionMemory initialized (max ${this.maxExchanges} exchanges)`);
    }

    /**
     * Add a new exchange to the buffer
     */
    addExchange(user: string, assistant: string, toolsUsed?: string[]) {
        // Truncate to control token usage
        const truncatedUser = this.truncate(user, this.maxUserChars);
        const truncatedAssistant = this.truncate(assistant, this.maxAssistantChars);

        this.context.exchanges.push({
            user: truncatedUser,
            assistant: truncatedAssistant,
            timestamp: Date.now(),
            toolsUsed,
        });

        // Keep only the last N exchanges
        if (this.context.exchanges.length > this.maxExchanges) {
            this.context.exchanges.shift();
        }

        logger.log(`Exchange added (${this.context.exchanges.length}/${this.maxExchanges})`);
    }

    /**
     * Replace the most recent exchange (edit resend / continue-after-questions redo).
     */
    replaceLastExchange(user: string, assistant: string, toolsUsed?: string[]) {
        const truncatedUser = this.truncate(user, this.maxUserChars);
        const truncatedAssistant = this.truncate(assistant, this.maxAssistantChars);
        const entry = {
            user: truncatedUser,
            assistant: truncatedAssistant,
            timestamp: Date.now(),
            toolsUsed,
        };
        if (this.context.exchanges.length === 0) {
            this.context.exchanges.push(entry);
        } else {
            this.context.exchanges[this.context.exchanges.length - 1] = entry;
        }
        logger.log(
            `Exchange replaced (${this.context.exchanges.length}/${this.maxExchanges})`,
        );
    }

    /**
     * Record an error that occurred
     */
    addError(error: string) {
        const truncated = this.truncate(error, 200);
        this.context.errors.push(truncated);

        // Keep only last 3 errors
        if (this.context.errors.length > 3) {
            this.context.errors.shift();
        }
    }

    /**
     * Set the current task description
     */
    setCurrentTask(task: string) {
        this.context.currentTask = this.truncate(task, 200);
    }

    /**
     * Get formatted context for injection into system prompt
     * Returns empty string if no context yet
     */
    getContextForPrompt(): string {
        return this.getContextForPromptMaxExchanges(this.maxExchanges);
    }

    /**
     * Same as getContextForPrompt but keeps only the last `max` exchanges (for context budget pruning).
     */
    getContextForPromptMaxExchanges(max: number): string {
        if (this.context.exchanges.length === 0 && !this.context.currentTask) {
            return '';
        }

        const cap = Math.max(1, Math.floor(max));
        const exchanges =
            this.context.exchanges.length > cap
                ? this.context.exchanges.slice(-cap)
                : [...this.context.exchanges];

        const parts: string[] = ['## Session Context'];

        if (this.context.currentTask) {
            parts.push(`\n**Current Task:** ${this.context.currentTask}`);
        }

        if (exchanges.length > 0) {
            parts.push('\n**Recent Conversation:**');
            exchanges.forEach((ex, i) => {
                parts.push(`${i + 1}. User: ${ex.user}`);
                parts.push(`   Assistant: ${ex.assistant}`);
                if (ex.toolsUsed && ex.toolsUsed.length > 0) {
                    parts.push(`   Tools: ${ex.toolsUsed.join(', ')}`);
                }
            });
        }

        if (this.context.errors.length > 0) {
            parts.push('\n**Recent Errors:**');
            this.context.errors.forEach((err, i) => {
                parts.push(`${i + 1}. ${err}`);
            });
        }

        return parts.join('\n');
    }

    /**
     * Get raw exchange count
     */
    getExchangeCount(): number {
        return this.context.exchanges.length;
    }

    /**
     * Estimate token count for the context
     * Rough approximation: 1 token ≈ 4 chars
     */
    estimateTokens(): number {
        const contextStr = this.getContextForPrompt();
        return Math.ceil(contextStr.length / 4);
    }

    /**
     * Clear all context
     */
    clear() {
        this.context = {
            exchanges: [],
            errors: [],
        };
        logger.log('SessionMemory cleared');
    }

    /**
     * Truncate text to max length, adding ellipsis if needed
     */
    private truncate(text: string, maxLength: number): string {
        if (!text) return '';

        // Remove newlines for compactness
        const cleaned = text.replace(/\n+/g, ' ').trim();

        if (cleaned.length <= maxLength) {
            return cleaned;
        }

        return cleaned.slice(0, maxLength - 3) + '...';
    }
}

// ═══════════════════════════════════════════════════════════
// GLOBAL SESSION MEMORY REGISTRY
// ═══════════════════════════════════════════════════════════

// Map of chatId -> SessionMemory
const sessionMemories = new Map<number, SessionMemory>();

/**
 * Get or create session memory for a chat
 */
export function getSessionMemory(chatId: number): SessionMemory {
    if (!sessionMemories.has(chatId)) {
        sessionMemories.set(chatId, new SessionMemory());
        logger.log(`Created session memory for chat ${chatId}`);
    }
    return sessionMemories.get(chatId)!;
}

/**
 * Clear session memory for a chat
 */
export function clearSessionMemory(chatId: number): void {
    if (sessionMemories.has(chatId)) {
        sessionMemories.get(chatId)!.clear();
        sessionMemories.delete(chatId);
        logger.log(`Cleared session memory for chat ${chatId}`);
    }
}

/**
 * Clear all session memories (for app shutdown)
 */
export function clearAllSessionMemories(): void {
    sessionMemories.clear();
    logger.log('All session memories cleared');
}

/** Rebuild rolling session memory after resuming a persisted workspace session. */
export function rebuildSessionMemoryFromMessages(
    memoryKey: number,
    messages: { role: string; content: string }[],
): void {
    clearSessionMemory(memoryKey);
    const mem = getSessionMemory(memoryKey);
    for (let i = 0; i < messages.length - 1; i++) {
        const user = messages[i];
        const assistant = messages[i + 1];
        if (user.role === "user" && assistant.role === "assistant") {
            mem.addExchange(user.content ?? "", assistant.content ?? "");
            i++;
        }
    }
}

export default SessionMemory;
