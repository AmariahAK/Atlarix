/**
 * useBrowserErrorListener
 * =======================
 * Feeds `browserErrorsAtom` — the PARSED, file-grouped build/dev-server errors
 * shown at the top of the Console tab, with "Fix All".
 *
 * Sources:
 * 1. `browser:error` (onBrowserSurfaceError) — error/warning entries from the
 *    in-app browser tabs.
 * 2. Window `message` / `error` events — dev-server HMR payloads reaching the
 *    app window.
 *
 * NOT the page console. That is a separate chronological stream at every level,
 * fed by `usePageConsoleListener` from the coalesced `browser:console` channel.
 * Both render in the same tab; keep them apart, because one is a set of problems
 * to work through and the other is a sequence of events.
 *
 * (A third source, a CDP debugger attached to the APP window, was removed with
 * the Console tab. It predated v14.15.0's move of the user's app out of an
 * in-window iframe and into a Browser tab — a separate WebContentsView, so a
 * separate CDP target it could never see — while still forwarding Atlarix's own
 * renderer errors to users as errors in their app.)
 */

import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { browserErrorsAtom, dismissedErrorSignaturesAtom, getErrorSignature, type BrowserError } from '@/atoms/sourceAtoms';
import { IpcClient } from '@/ipc/ipc_client';

export function useBrowserErrorListener() {
    const setErrors = useSetAtom(browserErrorsAtom);
    const setDismissedSignatures = useSetAtom(dismissedErrorSignaturesAtom);

    useEffect(() => {
        /**
         * Normalize error message for deduplication
         * Strips variable parts like line numbers, timestamps, etc.
         */
        const normalizeMessage = (msg: string): string => {
            return msg
                .replace(/at line \d+/gi, '')
                .replace(/:\d+:\d+/g, '') // Remove :line:col
                .replace(/\?t=\d+/g, '') // Remove cache-busting params
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 100); // First 100 chars for comparison
        };

        // Track seen error hashes to prevent duplicates across all sources
        const seenErrorHashes = new Set<string>();

        /**
         * Check if error is a duplicate of an existing one
         * Uses both in-memory hash set AND existing errors list
         */
        const isDuplicateError = (newError: BrowserError, existingErrors: BrowserError[]): boolean => {
            const normalizedNew = normalizeMessage(newError.message);
            const errorHash = `${normalizedNew}-${newError.file || ''}-${newError.line || ''}`;

            // Check hash set first (catches same error from multiple sources)
            if (seenErrorHashes.has(errorHash)) {
                return true;
            }

            // Check existing errors (5-second window)
            const isDupe = existingErrors.some(e => {
                if (Date.now() - (e.timestamp || 0) > 5000) return false;
                const normalizedExisting = normalizeMessage(e.message);
                return normalizedNew === normalizedExisting;
            });

            if (!isDupe) {
                seenErrorHashes.add(errorHash);
                // Limit hash set size to prevent memory leak
                if (seenErrorHashes.size > 100) {
                    const first = seenErrorHashes.values().next().value;
                    if (first) seenErrorHashes.delete(first);
                }
            }

            return isDupe;
        };
        /**
         * Filter out internal/library errors that aren't actionable
         * - CDN library errors (jsdelivr, unpkg, etc.)
         * - Browser extension errors
         * - Atlarix's own renderer process errors (same port as Atlarix app)
         */

        // Get Atlarix's renderer port (the port this app runs on)
        const atlarixPort = window.location.port;

        const shouldIgnoreError = (message: string, source?: string): boolean => {
            // Ignore errors from Atlarix's own renderer process
            // Errors from Atlarix come from the same port as the app itself
            // User project errors come from a different port (their preview dev server)
            if (source) {
                try {
                    const errorUrl = new URL(source);
                    if (errorUrl.port === atlarixPort || errorUrl.port === '') {
                        // Same port as Atlarix = Atlarix internal error, ignore it
                        console.debug('[useBrowserErrorListener] Ignoring Atlarix internal error from port:', errorUrl.port || 'default');
                        return true;
                    }
                } catch {
                    // Not a valid URL, continue with other checks
                }
            }

            // CDN library files (not user's code)
            const cdnPatterns = [
                'cdn.jsdelivr.net',
                'unpkg.com',
                'esm.sh',
                'cdnjs.cloudflare.com',
            ];
            if (source && cdnPatterns.some(pattern => source.includes(pattern))) {
                return true;
            }
            if (message && cdnPatterns.some(pattern => message.includes(pattern))) {
                return true;
            }

            // Browser extension errors
            if (source?.startsWith('chrome-extension://') ||
                source?.startsWith('moz-extension://')) {
                return true;
            }

            // Autofill-related errors (Chrome DevTools)
            if (message.includes('Autofill.enable') ||
                message.includes('Autofill.setAddresses')) {
                return true;
            }

            return false;
        };

        /**
         * Extract line number from file path or stack trace
         * Patterns: file.ts:9:5, file.ts:9, http://localhost:5174/src/file.ts:9
         */
        const extractLineNumber = (source?: string, stack?: string): { line?: number; column?: number } => {
            // Try source path first (often includes line:col after file extension)
            if (source) {
                // Match line:col after file extension: .ts:9:5 or .tsx:9 or .js:1
                // This avoids matching port numbers like :5174
                const sourceMatch = source.match(/\.[a-zA-Z]{2,4}:(\d+)(?::(\d+))?(?:\?.*)?$/);
                if (sourceMatch) {
                    return {
                        line: parseInt(sourceMatch[1], 10),
                        column: sourceMatch[2] ? parseInt(sourceMatch[2], 10) : undefined
                    };
                }
            }

            // Try stack trace
            if (stack) {
                // Common patterns: "at file.ts:9:5" or "(file.ts:9:5)"
                const stackMatch = stack.match(/(?:at\s+.*?)?(?:\()?([^:\s()]+):(\d+):(\d+)/);
                if (stackMatch) {
                    return {
                        line: parseInt(stackMatch[2], 10),
                        column: parseInt(stackMatch[3], 10)
                    };
                }
            }

            return {};
        };

        // Clear the parsed build errors when a file operation succeeds — anything
        // still broken is reported again by the next dev-server output.
        // (Type assertion: window.electron's type doesn't declare `.on`.)
        const ipcRenderer = window.electron?.ipcRenderer as any;
        const handleOperationStatus = (payload: any) => {
            // When any file operation completes successfully, clear all browser errors
            // If errors still exist, the browser will report them again
            if (payload.status === 'completed') {
                console.log('[useBrowserErrorListener] ✅ Operation completed - clearing all browser errors (they will re-appear if still present)');
                setErrors([]);
            }
        };
        ipcRenderer?.on?.('operation-status', handleOperationStatus);

        const handleMessage = (event: MessageEvent) => {
            // Log all messages for debugging (comment out in production)
            if (event.data?.type) {
                console.log('[useBrowserErrorListener] Received message:', event.data.type, event.data);
            }

            // Vite sends HMR update messages including errors
            // Check for various error message formats from dev servers

            if (event.data && typeof event.data === 'object') {
                const data = event.data;

                // ================================================
                // Atlarix Error Capture Script (from injected shim)
                // Captures: runtime errors, promise rejections, 
                // console.error, Vite overlay, Next.js overlay
                // ================================================
                if (data.type === 'atlarix-error' && data.payload) {
                    console.log('[useBrowserErrorListener] Processing atlarix-error:', data.payload);
                    const payload = data.payload;

                    // Filter out internal/library errors
                    const errorMessage = payload.message || '';
                    const errorSource = payload.file || payload.source || '';
                    if (shouldIgnoreError(errorMessage, errorSource)) {
                        console.log('[useBrowserErrorListener] Ignoring internal atlarix-error:', errorMessage.slice(0, 60));
                        return;
                    }

                    // Map errorType to our type system
                    // New format uses: 'runtime', 'unhandled-rejection', 'console-error', 'build'
                    // Old format uses: 'error', 'console-error', 'unhandled-rejection'
                    const errorType = payload.errorType || payload.type || 'runtime';
                    const isBuildError = errorType === 'build';

                    // Extract line number from source/stack if not directly provided
                    const sourcePath = payload.file || payload.source;
                    const providedLine = payload.line || payload.lineno;
                    const extracted = (!providedLine && sourcePath)
                        ? extractLineNumber(sourcePath, payload.stack)
                        : {};

                    const error: BrowserError = {
                        id: `atlarix-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                        type: isBuildError ? 'build' : 'runtime',
                        severity: 'error',
                        framework: isBuildError ? 'vite' : 'browser',
                        actionable: true, // All browser errors can be sent to AI
                        message: payload.message || 'Unknown error',
                        // Support both old (source) and new (file) field names
                        file: sourcePath,
                        line: providedLine || extracted.line,
                        column: payload.column || payload.colno || extracted.column,
                        stack: payload.stack,
                        // Include frame for Vite build errors (source code snippet)
                        rawOutput: payload.frame,
                        timestamp: payload.timestamp || Date.now(),
                    };

                    setDismissedSignatures((prev) => {
                        const next = new Set(prev);
                        next.delete(getErrorSignature(error));
                        return next;
                    });
                    setErrors((prev) => {
                        // Avoid duplicates using normalized comparison
                        if (isDuplicateError(error, prev)) {
                            console.log('[useBrowserErrorListener] Duplicate error, ignoring');
                            return prev;
                        }
                        console.log('[useBrowserErrorListener] Adding error to browserErrorsAtom:', error.type, error.message);
                        return [...prev, error];
                    });
                    return; // Don't process further
                }

                // Vite error overlay - catches compilation errors
                if (data.type === 'error' || data.type === 'full-reload-error') {
                    const error: BrowserError = {
                        id: `vite-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                        type: 'build',
                        severity: 'error',
                        framework: 'vite',
                        actionable: true,
                        message: data.err?.message || data.message || 'Unknown error',
                        file: data.err?.file || data.err?.loc?.file,
                        line: data.err?.loc?.line,
                        stack: data.err?.stack,
                        timestamp: Date.now(),
                    };

                    setDismissedSignatures((prev) => {
                        const next = new Set(prev);
                        next.delete(getErrorSignature(error));
                        return next;
                    });
                    setErrors((prev) => {
                        // Avoid duplicates using normalized comparison
                        if (isDuplicateError(error, prev)) return prev;
                        return [...prev, error];
                    });
                }

                // Webpack/CRA error format
                if (data.type === 'webpackHotUpdate' && data.errors?.length) {
                    data.errors.forEach((errMsg: string) => {
                        const error: BrowserError = {
                            id: `webpack-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                            type: 'build',
                            severity: 'error',
                            framework: 'webpack',
                            actionable: true,
                            message: errMsg,
                            timestamp: Date.now(),
                        };

                        setDismissedSignatures((prev) => {
                            const next = new Set(prev);
                            next.delete(getErrorSignature(error));
                            return next;
                        });
                        setErrors((prev) => {
                            const isDuplicate = prev.some(
                                e => e.message === error.message &&
                                    Date.now() - e.timestamp < 5000
                            );
                            if (isDuplicate) return prev;
                            return [...prev, error];
                        });
                    });
                }

                // ================================================
                // SIMPLE TODO APPROACH: HMR Success = Clear ALL Errors
                // If errors still exist, browser will report them again
                // ================================================
                if (data.type === 'update' && Array.isArray(data.updates) && data.updates.length > 0) {
                    console.log('[useBrowserErrorListener] ✅ HMR update success - clearing all errors (they will re-appear if still present)');
                    setErrors([]);
                }

                // Vite full-reload success - clear all errors
                if (data.type === 'full-reload') {
                    console.log('[useBrowserErrorListener] ✅ Full reload - clearing all errors');
                    setErrors([]);
                }
            }
        };

        // Also handle unhandled promise rejections that might bubble up
        const handleError = (event: ErrorEvent) => {
            // Only capture if it seems to come from our iframe (localhost dev servers)
            if (event.filename?.includes('localhost')) {
                const error: BrowserError = {
                    id: `runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    type: 'runtime',
                    severity: 'error',
                    framework: 'browser',
                    actionable: false,
                    message: event.message,
                    file: event.filename,
                    line: event.lineno,
                    column: event.colno,
                    timestamp: Date.now(),
                };

                setDismissedSignatures((prev) => {
                    const next = new Set(prev);
                    next.delete(getErrorSignature(error));
                    return next;
                });
                setErrors((prev) => {
                    const isDuplicate = prev.some(
                        e => e.message === error.message &&
                            Date.now() - e.timestamp < 5000
                    );
                    if (isDuplicate) return prev;
                    return [...prev, error];
                });
            }
        };

        window.addEventListener('message', handleMessage);
        window.addEventListener('error', handleError);

        // The browser tabs are native WebContentsViews, so runtime errors arrive
        // over the browser:error IPC (console / uncaught-with-stack / load /
        // crash / failed-network). Map and feed them through the same
        // dedup/ignore pipeline as every other source.
        const offPreviewError = IpcClient.getInstance().onBrowserSurfaceError((entry) => {
            const message = entry?.message || '';
            if (!message || shouldIgnoreError(message, entry?.url || '')) return;
            const error: BrowserError = {
                id: `browser-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                type: entry.type === 'load-failed' ? 'build' : 'runtime',
                severity: entry.level === 'warning' ? 'warning' : 'error',
                framework: 'browser',
                actionable: true,
                message,
                file: entry.url,
                stack: entry.stack,
                timestamp: entry.timestamp || Date.now(),
            };
            setDismissedSignatures((prev) => {
                const next = new Set(prev);
                next.delete(getErrorSignature(error));
                return next;
            });
            setErrors((prev) => (isDuplicateError(error, prev) ? prev : [...prev, error]));
        });

        return () => {
            window.removeEventListener('message', handleMessage);
            window.removeEventListener('error', handleError);
            ipcRenderer?.removeListener?.('operation-status', handleOperationStatus);
            offPreviewError();
        };
    }, [setErrors, setDismissedSignatures]);
}
