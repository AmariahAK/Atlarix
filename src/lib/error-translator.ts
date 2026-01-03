/**
 * Error Translator
 * =================
 * Translates cryptic error codes into human-readable messages.
 * Helps non-dev users understand what went wrong.
 */

// Common error codes → human-readable translation
export const ERROR_TRANSLATIONS: Record<string, { message: string; suggestion: string }> = {
    // File system errors
    'ENOENT': {
        message: 'File or folder not found',
        suggestion: 'Check if the path exists or create the missing file/folder.'
    },
    'EACCES': {
        message: 'Permission denied',
        suggestion: 'Try running with elevated permissions or check file ownership.'
    },
    'EEXIST': {
        message: 'File or folder already exists',
        suggestion: 'Remove the existing file or use a different name.'
    },
    'EISDIR': {
        message: 'Expected a file but found a directory',
        suggestion: 'Check the path - you may be targeting a folder instead of a file.'
    },
    'ENOTDIR': {
        message: 'Expected a directory but found a file',
        suggestion: 'Check the path - you may be targeting a file instead of a folder.'
    },
    'EMFILE': {
        message: 'Too many files open',
        suggestion: 'Close some applications or increase the file descriptor limit.'
    },

    // Network errors
    'ECONNREFUSED': {
        message: 'Could not connect to server',
        suggestion: 'Check if the server is running and the port is correct.'
    },
    'ETIMEDOUT': {
        message: 'Connection timed out',
        suggestion: 'Check your internet connection or try again later.'
    },
    'ENOTFOUND': {
        message: 'Server not found',
        suggestion: 'Check the URL or your DNS settings.'
    },
    'ECONNRESET': {
        message: 'Connection was reset',
        suggestion: 'The server closed the connection unexpectedly. Try again.'
    },

    // NPM-specific errors  
    'ERESOLVE': {
        message: 'Dependency version conflict',
        suggestion: 'Try running with --legacy-peer-deps or --force flag.'
    },
    'E404': {
        message: 'Package not found',
        suggestion: 'Check the package name spelling or if it exists on npm.'
    },
    'ETARGET': {
        message: 'Package version not found',
        suggestion: 'Check if the specified version exists.'
    },
    'EINTEGRITY': {
        message: 'Package integrity check failed',
        suggestion: 'Try deleting node_modules and package-lock.json, then reinstall.'
    },

    // Git errors
    'ENOREPOSITORY': {
        message: 'Not a git repository',
        suggestion: 'Initialize git with "git init" or navigate to a git project.'
    },

    // Process errors
    'EPERM': {
        message: 'Operation not permitted',
        suggestion: 'Check file permissions or run with elevated privileges.'
    },
    'ESRCH': {
        message: 'Process not found',
        suggestion: 'The process may have already terminated.'
    },
};

/**
 * Translate an error code to human-readable message
 */
export function translateError(errorOutput: string): { code: string; message: string; suggestion: string } | null {
    // Try to find known error codes in the output
    for (const [code, translation] of Object.entries(ERROR_TRANSLATIONS)) {
        if (errorOutput.includes(code)) {
            return { code, ...translation };
        }
    }

    // Try to extract common patterns
    if (errorOutput.includes('command not found') || errorOutput.includes('not recognized')) {
        return {
            code: 'COMMAND_NOT_FOUND',
            message: 'Command not installed',
            suggestion: 'Install the required tool or check if it\'s in your PATH.',
        };
    }

    if (errorOutput.includes('permission denied') || errorOutput.includes('Permission denied')) {
        return {
            code: 'PERMISSION',
            message: 'Permission denied',
            suggestion: 'Check file permissions or try running with sudo.',
        };
    }

    if (errorOutput.includes('could not determine executable')) {
        return {
            code: 'EXEC_NOT_FOUND',
            message: 'Executable not found',
            suggestion: 'The package may not have been installed correctly. Try reinstalling.',
        };
    }

    if (errorOutput.includes('npm error') || errorOutput.includes('npm ERR!')) {
        return {
            code: 'NPM_ERROR',
            message: 'NPM package error',
            suggestion: 'Check the npm error log for details. Try clearing npm cache with "npm cache clean --force".',
        };
    }

    return null; // No translation found
}

/**
 * Generate a short summary of the error for display
 */
export function summarizeError(errorOutput: string, maxLength: number = 100): string {
    // Try to get a translation first
    const translation = translateError(errorOutput);
    if (translation) {
        return translation.message;
    }

    // Otherwise, extract the most relevant line
    const lines = errorOutput.split('\n').filter(l => l.trim());

    // Look for lines that start with "error:", "Error:", "ERR!", etc.
    const errorLine = lines.find(l =>
        /^(error|err!|fatal|failed|exception)/i.test(l.trim())
    );

    if (errorLine) {
        return errorLine.length > maxLength
            ? errorLine.substring(0, maxLength) + '...'
            : errorLine;
    }

    // Just return the first non-empty line
    const firstLine = lines[0] || 'Unknown error';
    return firstLine.length > maxLength
        ? firstLine.substring(0, maxLength) + '...'
        : firstLine;
}
