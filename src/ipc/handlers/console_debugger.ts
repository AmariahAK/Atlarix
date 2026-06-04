/**
 * Console Debugger
 * ================
 * Captures browser console errors using Electron's Chrome DevTools Protocol.
 * 
 * This replaces the old proxy-based approach with a more reliable CDP method
 * that doesn't require script injection into iframes.
 */

import { BrowserWindow } from 'electron';
import log from 'electron-log';

const logger = log.scope('console-debugger');

interface CDPConsoleMessage {
    source: string;
    level: 'log' | 'warning' | 'error' | 'debug' | 'info';
    text: string;
    url?: string;
    line?: number;
    column?: number;
}

// Atlarix's dev server port - errors from this port are internal, not user's code
const ATLARIX_DEV_PORT = '5173';

/**
 * Check if an error is from Atlarix itself or internal Electron sources
 * These should NOT be shown to users as they're not related to their code
 */
function isAtlarixOrInternalError(url?: string, message?: string): boolean {
    // Skip if no URL (can't determine source)
    if (!url) return false;

    // Filter Atlarix's own dev server (port 5173)
    if (url.includes(`:${ATLARIX_DEV_PORT}/`) || url.includes(`localhost:${ATLARIX_DEV_PORT}`)) {
        return true;
    }

    // Filter internal Electron/Node sources
    const internalPatterns = [
        'node:electron',
        'devtools://',
        'chrome-extension://',
        'node:internal',
        'electron/js2c/',
    ];

    if (internalPatterns.some(pattern => url.includes(pattern))) {
        return true;
    }

    // Filter known Atlarix-specific warnings
    const atlarixMessagePatterns = [
        'listPrompts is deprecated',  // Internal deprecation warning
        'Electron Security Warning',  // Electron dev warnings
        'Content-Security-Policy',    // CSP warnings from Electron
    ];

    if (message && atlarixMessagePatterns.some(pattern => message.includes(pattern))) {
        return true;
    }

    return false;
}

// Track attached debuggers to avoid duplicates
const attachedWebContents = new Set<number>();

/**
 * Attach debugger to a BrowserWindow to capture console messages
 */
export function attachConsoleDebugger(win: BrowserWindow): void {
    const webContents = win.webContents;

    if (attachedWebContents.has(webContents.id)) {
        logger.debug(`Debugger already attached to webContents ${webContents.id}`);
        return;
    }

    try {
        // Attach debugger using CDP protocol 1.3
        webContents.debugger.attach('1.3');
        attachedWebContents.add(webContents.id);
        logger.log(`✅ Debugger attached to webContents ${webContents.id}`);
    } catch (err) {
        // Might already be attached
        logger.debug(`Debugger attach failed (may already be attached): ${err}`);
        return;
    }

    // Enable console domain to receive console messages
    webContents.debugger.sendCommand('Console.enable').catch(err => {
        logger.warn(`Failed to enable Console domain: ${err}`);
    });

    // Enable Runtime domain for uncaught exceptions
    webContents.debugger.sendCommand('Runtime.enable').catch(err => {
        logger.warn(`Failed to enable Runtime domain: ${err}`);
    });

    // Listen for debugger messages
    webContents.debugger.on('message', (_event, method, params) => {
        // Handle console messages
        if (method === 'Console.messageAdded') {
            const message = params.message as CDPConsoleMessage;

            // Only capture errors and warnings
            if (message.level === 'error' || message.level === 'warning') {
                // Filter out Atlarix's own errors (port 5173) and internal Electron errors
                if (isAtlarixOrInternalError(message.url, message.text)) {
                    logger.debug(`[Filtered] Skipping Atlarix/internal error: ${message.text?.slice(0, 50)}...`);
                    return;
                }

                logger.debug(`[Console.${message.level}] ${message.text}`);

                // Send to renderer process
                webContents.send('browser-console-error', {
                    type: message.level,
                    message: message.text,
                    source: message.url,
                    line: message.line,
                    column: message.column,
                    timestamp: Date.now(),
                });
            }
        }

        // Handle uncaught exceptions
        if (method === 'Runtime.exceptionThrown') {
            const { exceptionDetails } = params;
            const description = exceptionDetails?.exception?.description ||
                exceptionDetails?.text ||
                'Unknown exception';

            // Filter out Atlarix's own errors
            if (isAtlarixOrInternalError(exceptionDetails?.url, description)) {
                logger.debug(`[Filtered] Skipping Atlarix/internal exception: ${description?.slice(0, 50)}...`);
                return;
            }

            logger.debug(`[Runtime.exception] ${description}`);

            webContents.send('browser-console-error', {
                type: 'error',
                message: description,
                source: exceptionDetails?.url,
                line: exceptionDetails?.lineNumber,
                column: exceptionDetails?.columnNumber,
                stack: exceptionDetails?.exception?.description,
                timestamp: Date.now(),
            });
        }
    });

    // Handle debugger detachment
    webContents.debugger.on('detach', (_event, reason) => {
        logger.log(`Debugger detached from webContents ${webContents.id}: ${reason}`);
        attachedWebContents.delete(webContents.id);
    });

    // Clean up when window is closed
    win.on('closed', () => {
        attachedWebContents.delete(webContents.id);
    });
}

/**
 * Clear browser console buffer via CDP
 * Call this after successful file operations to prevent stale errors from reappearing.
 * 
 * Why this is needed:
 * - CDP reports console messages from the browser's internal buffer
 * - When React state clears errors, CDP still has old entries
 * - This clears the actual browser console buffer
 */
export function clearConsoleBuffer(win: BrowserWindow): void {
    const webContents = win.webContents;

    if (!attachedWebContents.has(webContents.id)) {
        logger.debug(`No debugger attached to webContents ${webContents.id}, skipping console clear`);
        return;
    }

    webContents.debugger.sendCommand('Console.clearMessages')
        .then(() => {
            logger.log(`✅ Console buffer cleared for webContents ${webContents.id}`);
            // Notify renderer that buffer was cleared so it can reset its state
            webContents.send('browser-console-cleared', { timestamp: Date.now() });
        })
        .catch(err => {
            logger.warn(`Failed to clear console buffer: ${err}`);
        });
}

/**
 * Clear console buffers for all windows
 * Call this after successful operations (file write, HMR success, etc.)
 */
export function clearAllConsoleBuffers(): void {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
        clearConsoleBuffer(win);
    }
    logger.log(`Cleared console buffers for ${windows.length} window(s)`);
}
