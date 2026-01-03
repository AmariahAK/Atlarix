/**
 * Auto-Recovery Manager
 * =====================
 * Analyzes command failures and determines recovery strategy.
 * Auto-recoverable errors get injected back to AI for self-healing.
 */

import { analyzeCommandFailure } from './error-recovery';

export interface ApprovedOperation {
    id: string;
    type: 'run_command' | 'write_file' | 'delete_file' | 'rename_file';
    command?: string;
    path?: string;
}

export interface FailedOperation {
    id: string;
    operation: ApprovedOperation;
    error: string;
    stderr: string;
    stdout: string;
    exitCode: number;
    duration: number;
    timestamp: string;
}

export interface RecoveryStrategy {
    type: 'auto_inject' | 'manual_retry' | 'skip';
    reason: string;
    userPrompt?: string;
}

interface CommandExecutionResult {
    error?: string;
    stderr?: string;
    stdout?: string;
    exitCode: number;
    duration: number;
}

export class AutoRecoveryManager {
    private failedOps: Map<string, FailedOperation> = new Map();
    private recoveryAttempts: Map<string, number> = new Map();
    private readonly MAX_RETRY_ATTEMPTS = 2;

    /**
     * Records a failed operation
     */
    recordFailure(op: ApprovedOperation, result: CommandExecutionResult): void {
        this.failedOps.set(op.id, {
            id: op.id,
            operation: op,
            error: result.error || 'Unknown error',
            stderr: result.stderr || '',
            stdout: result.stdout || '',
            exitCode: result.exitCode,
            duration: result.duration,
            timestamp: new Date().toISOString(),
        });

        // Track retry attempts
        const attempts = this.recoveryAttempts.get(op.id) || 0;
        this.recoveryAttempts.set(op.id, attempts + 1);
    }

    /**
     * Decides if we should auto-inject recovery or let user handle it
     */
    getRecoveryStrategy(opId: string): RecoveryStrategy {
        const failure = this.failedOps.get(opId);
        if (!failure) {
            return { type: 'skip', reason: 'No failure recorded' };
        }

        const attempts = this.recoveryAttempts.get(opId) || 0;

        // If we've tried too many times, stop auto-recovery
        if (attempts > this.MAX_RETRY_ATTEMPTS) {
            return {
                type: 'manual_retry',
                reason: `Max retry attempts (${this.MAX_RETRY_ATTEMPTS}) reached`,
            };
        }

        // Check if error is auto-recoverable
        const analysis = analyzeCommandFailure({
            command: failure.operation.command || '',
            exitCode: failure.exitCode,
            stderr: failure.stderr,
            stdout: failure.stdout,
            duration: failure.duration,
            timestamp: failure.timestamp,
        });

        // Auto-recoverable errors (AI can likely fix these)
        const autoRecoverableTypes = [
            'dependency_conflict',
            'npm_executable_not_found',
            'module_not_found',
            'port_in_use',
            'file_not_found',
        ];

        if (autoRecoverableTypes.includes(analysis.errorType)) {
            return {
                type: 'auto_inject',
                reason: `Auto-recoverable error: ${analysis.errorType}`,
                userPrompt: this.buildRecoveryPrompt([failure]),
            };
        }

        // For syntax errors or permission issues, let user decide
        return {
            type: 'manual_retry',
            reason: `Manual intervention needed: ${analysis.errorType}`,
        };
    }

    /**
     * Builds a user prompt for AI to fix failed commands
     */
    buildRecoveryPrompt(failures: FailedOperation[]): string {
        if (failures.length === 0) return '';

        const header = `## ⚠️ Command Execution Failed

The following ${failures.length} operation(s) failed. Please analyze the errors and provide corrected commands.

`;

        const errorList = failures.map((f, idx) => {
            const analysis = analyzeCommandFailure({
                command: f.operation.command || '',
                exitCode: f.exitCode,
                stderr: f.stderr,
                stdout: f.stdout,
                duration: f.duration,
                timestamp: f.timestamp,
            });

            return `### ${idx + 1}. ${f.operation.type === 'run_command' ? 'Command Failed' : 'Operation Failed'}

**Command:** \`${f.operation.command || f.operation.path}\`
**Exit Code:** ${f.exitCode}
**Error Type:** ${analysis.humanMessage}

**AI Analysis:**
${analysis.aiHint}

${analysis.suggestedFix ? `**Suggested Fix:**
\`\`\`bash
${analysis.suggestedFix}
\`\`\`` : ''}

**Terminal Output:**
\`\`\`
${this.extractLastLines(f.stderr || f.stdout, 10)}
\`\`\``;
        }).join('\n\n---\n\n');

        const footer = `

Please:
1. Analyze each error
2. Suggest corrected commands
3. Request the corrected operations`;

        return header + errorList + footer;
    }

    /**
     * Gets all failures from the current sequence
     */
    getAllFailures(): FailedOperation[] {
        return Array.from(this.failedOps.values());
    }

    /**
     * Gets auto-recoverable failures only
     */
    getAutoRecoverableFailures(): FailedOperation[] {
        return this.getAllFailures().filter(f => {
            const strategy = this.getRecoveryStrategy(f.id);
            return strategy.type === 'auto_inject';
        });
    }

    /**
     * Clears failure after successful recovery
     */
    clearFailure(opId: string): void {
        this.failedOps.delete(opId);
        this.recoveryAttempts.delete(opId);
    }

    /**
     * Clears all failures (new sequence started)
     */
    clearAll(): void {
        this.failedOps.clear();
        this.recoveryAttempts.clear();
    }

    private extractLastLines(text: string, count: number): string {
        const lines = text.split('\n').filter(Boolean);
        return lines.slice(-count).join('\n');
    }
}

// Singleton instance
export const recoveryManager = new AutoRecoveryManager();
