/**
 * Error Recovery System
 * =====================
 * Analyzes command failures and provides recovery hints for both AI and humans.
 * The AI receives detailed context to attempt self-correction.
 */

export interface CommandFailure {
    command: string;
    exitCode: number;
    stderr: string;
    stdout: string;
    duration: number;
    timestamp: string;
}

export interface RecoveryHint {
    errorType: string;
    humanMessage: string;
    aiHint: string;
    suggestedFix?: string;
}

/**
 * Analyzes command failures and provides recovery hints
 */
export function analyzeCommandFailure(failure: CommandFailure): RecoveryHint {
    const { command, stderr, exitCode, stdout } = failure;
    const output = stderr || stdout || '';

    // Pattern matching for common errors

    // 1. npm "could not determine executable to run" - MOST COMMON
    if (output.includes('could not determine executable to run')) {
        return {
            errorType: 'npm_executable_not_found',
            humanMessage: 'npm could not find the executable',
            aiHint: 'The command failed because npm could not find the executable after install. This happens when running chained commands like "npm install X && npx X". Split into separate commands: first install, wait for success, then run npx.',
            suggestedFix: splitChainedCommand(command),
        };
    }

    // 2. npm/pnpm dependency conflicts
    if (output.includes('ERESOLVE') || output.includes('could not resolve dependency')) {
        return {
            errorType: 'dependency_conflict',
            humanMessage: 'Dependency version conflict detected',
            aiHint: 'The package versions are incompatible. Try adding --legacy-peer-deps flag or use --force.',
            suggestedFix: command.replace('npm install', 'npm install --legacy-peer-deps'),
        };
    }

    // 3. Permission denied
    if (output.includes('EACCES') || output.includes('Permission denied')) {
        return {
            errorType: 'permission_denied',
            humanMessage: 'Permission denied',
            aiHint: 'The command requires elevated permissions. Consider running without sudo or fixing file permissions.',
        };
    }

    // 4. Port already in use
    if (output.includes('EADDRINUSE') || (output.includes('port') && output.includes('in use'))) {
        return {
            errorType: 'port_in_use',
            humanMessage: 'Port already in use',
            aiHint: 'The development server port is already occupied. Try killing existing processes or using a different port.',
        };
    }

    // 5. Module not found
    if (output.includes('Cannot find module') || output.includes('MODULE_NOT_FOUND')) {
        return {
            errorType: 'module_not_found',
            humanMessage: 'Required module not found',
            aiHint: 'A required dependency is missing. Run npm install first, or add the missing package.',
        };
    }

    // 6. Syntax errors in code
    if (output.includes('SyntaxError') || output.includes('Unexpected token')) {
        return {
            errorType: 'syntax_error',
            humanMessage: 'Syntax error in code',
            aiHint: 'There is a syntax error in one of the files. Review recent changes and fix syntax issues.',
        };
    }

    // 7. Network errors
    if (output.includes('ETIMEDOUT') || output.includes('ECONNREFUSED') || output.includes('ENOTFOUND')) {
        return {
            errorType: 'network_error',
            humanMessage: 'Network error',
            aiHint: 'A network request failed. Check internet connection and try again.',
        };
    }

    // 8. File/directory not found
    if (output.includes('ENOENT') || output.includes('no such file')) {
        return {
            errorType: 'file_not_found',
            humanMessage: 'File or directory not found',
            aiHint: 'The specified file or directory does not exist. Check the path and ensure prerequisite files are created.',
        };
    }

    // Default fallback
    return {
        errorType: 'unknown',
        humanMessage: `Command failed with exit code ${exitCode}`,
        aiHint: `The command "${truncate(command, 80)}" failed with exit code ${exitCode}. Review the error output and adjust the command or fix prerequisite issues.`,
    };
}

/**
 * Splits chained commands that npm can't handle
 */
function splitChainedCommand(command: string): string {
    // If command has && with npx, suggest splitting
    if (command.includes('&&') && command.includes('npx')) {
        const parts = command.split('&&').map(p => p.trim());
        // Return first command only
        return parts[0];
    }
    return command;
}

/**
 * Truncates text to max length
 */
function truncate(text: string, maxLen: number): string {
    return text.length > maxLen ? text.substring(0, maxLen) + '...' : text;
}

/**
 * Extracts last N lines from text
 */
function extractLastLines(text: string, count: number): string {
    const lines = text.split('\n').filter(Boolean);
    return lines.slice(-count).join('\n');
}

/**
 * Formats command failure for AI context injection
 * This is the CRITICAL format the AI will receive to understand what went wrong
 */
export function formatFailureForAI(failure: CommandFailure, hint: RecoveryHint): string {
    return `
## ⚠️ COMMAND FAILED - Please analyze and fix

**Command:** \`${failure.command}\`
**Exit Code:** ${failure.exitCode}
**Duration:** ${failure.duration}s

### Error Analysis
${hint.aiHint}

${hint.suggestedFix ? `### Suggested Fix
\`\`\`bash
${hint.suggestedFix}
\`\`\`` : ''}

### Terminal Output
\`\`\`
${extractLastLines(failure.stderr || failure.stdout || 'No output captured', 15)}
\`\`\`

**IMPORTANT:** This command FAILED - it was NOT rejected by the user. Please:
1. Analyze the error above
2. Suggest a corrected command or alternative approach
3. Do NOT assume the user denied permission - the command itself failed
`.trim();
}

/**
 * Formats command failure for human display
 */
export function formatFailureForHuman(failure: CommandFailure, hint: RecoveryHint): {
    title: string;
    message: string;
    suggestion: string;
    stderr: string;
} {
    return {
        title: `⚠️ Command Failed (Exit ${failure.exitCode})`,
        message: hint.humanMessage,
        suggestion: hint.suggestedFix || hint.aiHint,
        stderr: extractLastLines(failure.stderr || failure.stdout || '', 30),
    };
}
