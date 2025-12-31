/**
 * Terminal Output Slicer
 * ======================
 * Real-time slicing of terminal output to prevent context overflow.
 * Prioritizes errors, warnings, and maintains first/last lines for context.
 * 
 * Features:
 * - Circular buffer to keep last N lines
 * - Categorizes lines by type (error, warning, normal)
 * - Slices output for AI with priority: Errors > Warnings > Last > First
 * - Prevents AI context overflow from long command output
 */

import log from "electron-log";

const logger = log.scope("TerminalOutputSlicer");

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

export interface TerminalSlice {
    /** First N lines of output (context) */
    header: string[];
    /** Lines containing errors or warnings */
    relevant: string[];
    /** Last N lines of output */
    footer: string[];
    /** How many lines were omitted */
    omittedLines: number;
    /** Exit code if available */
    exitCode?: number;
    /** Whether command is still running */
    isRunning: boolean;
}

// ════════════════════════════════════════════════════════════════════════════
// TERMINAL OUTPUT SLICER
// ════════════════════════════════════════════════════════════════════════════

export class TerminalOutputSlicer {
    private buffer: string[] = [];
    private errorLines: string[] = [];
    private warningLines: string[] = [];
    private lastLines: string[] = [];

    private exitCode?: number;
    private isRunning: boolean = true;

    private readonly MAX_BUFFER = 1000;
    private readonly MAX_LAST_LINES = 10;

    private readonly ERROR_KEYWORDS = [
        'error',
        'failed',
        'exception',
        'fatal',
        'err!',
        'enoent',
        'permission denied',
        'not found',
        'cannot find',
        'syntax error',
        'typeerror',
        'referenceerror',
        'segmentation fault',
        'abort',
        'killed',
    ];

    private readonly WARNING_KEYWORDS = [
        'warn',
        'warning',
        'deprecated',
        'caution',
        'notice',
        'advisory',
    ];

    /**
     * Reset slicer state for new command.
     */
    reset(): void {
        this.buffer = [];
        this.errorLines = [];
        this.warningLines = [];
        this.lastLines = [];
        this.exitCode = undefined;
        this.isRunning = true;
    }

    /**
     * Process incoming terminal data.
     * Called on each stdout/stderr chunk.
     */
    onData(chunk: string): void {
        const lines = chunk.split('\n').filter(line => line.trim());

        for (const line of lines) {
            // Add to circular buffer
            this.buffer.push(line);
            if (this.buffer.length > this.MAX_BUFFER) {
                this.buffer.shift();
            }

            // Categorize
            const lowerLine = line.toLowerCase();

            if (this.ERROR_KEYWORDS.some(kw => lowerLine.includes(kw))) {
                this.errorLines.push(line);
            } else if (this.WARNING_KEYWORDS.some(kw => lowerLine.includes(kw))) {
                this.warningLines.push(line);
            }

            // Always keep last N lines
            this.lastLines.push(line);
            if (this.lastLines.length > this.MAX_LAST_LINES) {
                this.lastLines.shift();
            }
        }
    }

    /**
     * Mark command as complete and record exit code.
     */
    complete(exitCode: number): void {
        this.exitCode = exitCode;
        this.isRunning = false;
    }

    /**
     * Get sliced output for AI.
     * Prioritizes: Errors > Warnings > Last lines > First lines
     * 
     * @param maxTokens - Maximum tokens for output (rough estimate: 1 token ≈ 4 chars)
     */
    getSlicedOutput(maxTokens: number = 2000): TerminalSlice {
        const approxCharsPerToken = 4;
        const maxChars = maxTokens * approxCharsPerToken;

        // Allocate budget
        const headerBudget = Math.floor(maxChars * 0.15);  // 15% for first lines
        const footerBudget = Math.floor(maxChars * 0.25);  // 25% for last lines
        const relevantBudget = Math.floor(maxChars * 0.60); // 60% for errors/warnings

        // Get header (first 5-10 lines)
        const headerLines = this.buffer.slice(0, 5);
        let headerChars = 0;
        const header = headerLines.filter(line => {
            if (headerChars + line.length <= headerBudget) {
                headerChars += line.length + 1;
                return true;
            }
            return false;
        });

        // Get footer (last lines)
        const footer = this.lastLines.slice(-Math.min(5, this.lastLines.length));

        // Get relevant lines (errors and warnings, prioritize errors)
        let relevantChars = 0;
        const relevant: string[] = [];

        // First add errors
        for (const line of this.errorLines.slice(-20)) {  // Last 20 errors max
            if (relevantChars + line.length <= relevantBudget) {
                relevant.push(line);
                relevantChars += line.length + 1;
            }
        }

        // Then add warnings if space
        for (const line of this.warningLines.slice(-10)) {  // Last 10 warnings max
            if (relevantChars + line.length <= relevantBudget) {
                relevant.push(line);
                relevantChars += line.length + 1;
            }
        }

        // Calculate omitted
        const uniqueShown = new Set([...header, ...relevant, ...footer]);
        const omittedLines = Math.max(0, this.buffer.length - uniqueShown.size);

        return {
            header,
            relevant,
            footer,
            omittedLines,
            exitCode: this.exitCode,
            isRunning: this.isRunning,
        };
    }

    /**
     * Get full output (for UI display).
     */
    getFullOutput(): string {
        return this.buffer.join('\n');
    }

    /**
     * Get line count stats.
     */
    getStats(): { total: number; errors: number; warnings: number } {
        return {
            total: this.buffer.length,
            errors: this.errorLines.length,
            warnings: this.warningLines.length,
        };
    }

    /**
     * Format sliced output as AI-friendly string.
     */
    static formatForAI(slice: TerminalSlice): string {
        const lines: string[] = [];

        // Status
        if (slice.isRunning) {
            lines.push('🔄 Command still running...');
        } else if (slice.exitCode === 0) {
            lines.push('✅ Command completed successfully');
        } else {
            lines.push(`❌ Command failed (exit code: ${slice.exitCode})`);
        }

        // Header
        if (slice.header.length > 0) {
            lines.push('\n--- First lines ---');
            lines.push(...slice.header);
        }

        // Errors/Warnings
        if (slice.relevant.length > 0) {
            lines.push('\n--- Errors/Warnings ---');
            lines.push(...slice.relevant);
        }

        // Footer
        if (slice.footer.length > 0) {
            lines.push('\n--- Last lines ---');
            lines.push(...slice.footer);
        }

        // Omitted notice
        if (slice.omittedLines > 0) {
            lines.push(`\n... (${slice.omittedLines} lines omitted) ...`);
        }

        return lines.join('\n');
    }
}

export default TerminalOutputSlicer;
