/**
 * useBrowserErrorListener
 * =======================
 * Hook to capture browser console errors from the live preview iframe.
 * 
 * Error sources:
 * 1. CDP Debugger (browser-console-error IPC) - Electron's debugger API
 * 2. PostMessage from iframe - Vite/Webpack HMR errors
 * 3. Window error events - Uncaught exceptions
 */

import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { browserErrorsAtom, type BrowserError } from '@/atoms/sourceAtoms';

export function useBrowserErrorListener() {
    const setErrors = useSetAtom(browserErrorsAtom);

    useEffect(() => {
        /**
         * Normalize error message for deduplication
         * Strips variable parts like line numbers, timestamps, etc.
         */
        const normalizeMessage = (msg: string): string => {
            return msg
                .replace(/at line \d+/gi, '')
                .replace(/:\d+:\d+/g, '') // Remove :line:col
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 100); // First 100 chars for comparison
        };

        /**
         * Check if error is a duplicate of an existing one
         */
        const isDuplicateError = (newError: BrowserError, existingErrors: BrowserError[]): boolean => {
            const normalizedNew = normalizeMessage(newError.message);
            return existingErrors.some(e => {
                // Within last 10 seconds
                if (Date.now() - (e.timestamp || 0) > 10000) return false;

                // Check normalized message similarity
                const normalizedExisting = normalizeMessage(e.message);
                return normalizedNew === normalizedExisting;
            });
        };
        /**
         * Filter out internal/library errors that aren't actionable
         * - Monaco editor internal errors (inmemory://model)
         * - CDN library errors (jsdelivr, unpkg, etc.)
         * - Browser extension errors
         * - Atlarix's own renderer process errors (same port as Atlarix app)
         */

        // Get Atlarix's renderer port (the port this app runs on)
        const atlarixPort = window.location.port;

        const shouldIgnoreError = (message: string, source?: string): boolean => {
            // Monaco TypeScript worker errors
            if (message.includes('inmemory://model') ||
                message.includes('Could not find source file:')) {
                return true;
            }

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
                'monaco-editor',
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

        // Listen for CDP debugger console errors (from main process)
        const handleCDPError = (payload: any) => {
            console.log('[useBrowserErrorListener] CDP console error:', payload);

            // Filter out internal/library errors
            if (shouldIgnoreError(payload.message || '', payload.source)) {
                console.log('[useBrowserErrorListener] Ignoring internal error:', payload.message?.slice(0, 60));
                return;
            }

            if (payload.type === 'error' || payload.type === 'warning') {
                const error: BrowserError = {
                    id: `cdp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    type: 'runtime',
                    severity: payload.type === 'warning' ? 'warning' : 'error',
                    framework: 'browser',
                    actionable: true,
                    message: payload.message || 'Unknown error',
                    file: payload.source,
                    line: payload.line,
                    column: payload.column,
                    stack: payload.stack,
                    timestamp: payload.timestamp || Date.now(),
                };

                setErrors((prev) => {
                    // Avoid duplicates using normalized comparison
                    if (isDuplicateError(error, prev)) return prev;
                    console.log('[useBrowserErrorListener] Adding CDP error:', error.message);
                    return [...prev, error];
                });
            }
        };

        // Register CDP listener (use type assertion since window.electron type doesn't include .on)
        const ipcRenderer = window.electron?.ipcRenderer as any;
        ipcRenderer?.on?.('browser-console-error', handleCDPError);

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

                    const error: BrowserError = {
                        id: `atlarix-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                        type: isBuildError ? 'build' : 'runtime',
                        severity: 'error',
                        framework: isBuildError ? 'vite' : 'browser',
                        actionable: true, // All browser errors can be sent to AI
                        message: payload.message || 'Unknown error',
                        // Support both old (source) and new (file) field names
                        file: payload.file || payload.source,
                        line: payload.line || payload.lineno,
                        column: payload.column || payload.colno,
                        stack: payload.stack,
                        // Include frame for Vite build errors (source code snippet)
                        rawOutput: payload.frame,
                        timestamp: payload.timestamp || Date.now(),
                    };

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
                // Vite HMR Success - Clear Errors for Updated Files
                // When HMR successfully updates files, clear old errors
                // ================================================
                if (data.type === 'update' && Array.isArray(data.updates)) {
                    // Extract file paths from HMR updates
                    const updatedFiles = data.updates
                        .map((update: any) => update.path || update.acceptedPath)
                        .filter(Boolean)
                        .map((path: string) => {
                            // Normalize path - remove query params and leading slash
                            return path.split('?')[0].replace(/^\//, '');
                        });

                    if (updatedFiles.length > 0) {
                        console.log('[useBrowserErrorListener] HMR update success, clearing errors for:', updatedFiles);

                        setErrors((prev) => {
                            const filtered = prev.filter(error => {
                                // Keep errors that don't have a file path
                                if (!error.file) return true;

                                // Check if this error's file was in the HMR update
                                const errorFile = error.file
                                    .split('?')[0]
                                    .replace(/^\//, '')
                                    .replace(/.*localhost:\d+\//, ''); // Remove localhost prefix

                                const wasUpdated = updatedFiles.some((uf: string) =>
                                    errorFile.endsWith(uf) || uf.endsWith(errorFile) || errorFile.includes(uf)
                                );

                                if (wasUpdated) {
                                    console.log('[useBrowserErrorListener] Clearing error for updated file:', errorFile);
                                }

                                return !wasUpdated;
                            });

                            return filtered;
                        });
                    }
                }

                // Vite full-reload success - clear all build errors
                if (data.type === 'full-reload') {
                    console.log('[useBrowserErrorListener] Full reload, clearing all build errors');
                    setErrors((prev) => prev.filter(error => error.type !== 'build'));
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

        return () => {
            window.removeEventListener('message', handleMessage);
            window.removeEventListener('error', handleError);
            ipcRenderer?.removeListener?.('browser-console-error', handleCDPError);
        };
    }, [setErrors]);
}

export default useBrowserErrorListener;
