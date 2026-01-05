/**
 * useBrowserErrorListener
 * =======================
 * Hook to capture browser console errors from the live preview iframe.
 * 
 * Vite's dev server sends error messages via postMessage when compilation
 * or runtime errors occur. This hook listens for those messages and updates
 * the browserErrorsAtom.
 */

import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { browserErrorsAtom, type BrowserError } from '@/atoms/sourceAtoms';

export function useBrowserErrorListener() {
    const setErrors = useSetAtom(browserErrorsAtom);

    useEffect(() => {
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
                // Atlarix Error Capture Script (from injected proxy)
                // This is the primary error source - captures console.error, 
                // window.onerror, and unhandled rejections from the iframe
                // ================================================
                if (data.type === 'atlarix-error' && data.payload) {
                    console.log('[useBrowserErrorListener] Processing atlarix-error:', data.payload);
                    const payload = data.payload;
                    const error: BrowserError = {
                        id: `atlarix-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                        type: payload.type === 'console-error' ? 'error'
                            : payload.type === 'unhandled-rejection' ? 'unhandled-rejection'
                                : 'error',
                        message: payload.message || 'Unknown error',
                        source: payload.source,
                        lineno: payload.lineno,
                        colno: payload.colno,
                        stack: payload.stack,
                        timestamp: payload.timestamp || Date.now(),
                    };

                    setErrors((prev) => {
                        // Avoid duplicates in last 5 seconds
                        const isDuplicate = prev.some(
                            e => e.message === error.message &&
                                Date.now() - e.timestamp < 5000
                        );
                        if (isDuplicate) {
                            console.log('[useBrowserErrorListener] Duplicate error, ignoring');
                            return prev;
                        }
                        console.log('[useBrowserErrorListener] Adding error to browserErrorsAtom');
                        return [...prev, error];
                    });
                    return; // Don't process further
                }

                // Vite error overlay - catches compilation errors
                if (data.type === 'error' || data.type === 'full-reload-error') {
                    const error: BrowserError = {
                        id: `vite-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                        type: 'error',
                        message: data.err?.message || data.message || 'Unknown error',
                        source: data.err?.file || data.err?.loc?.file,
                        lineno: data.err?.loc?.line,
                        stack: data.err?.stack,
                        timestamp: Date.now(),
                    };

                    setErrors((prev) => {
                        // Avoid duplicates in last 5 seconds
                        const isDuplicate = prev.some(
                            e => e.message === error.message &&
                                Date.now() - e.timestamp < 5000
                        );
                        if (isDuplicate) return prev;
                        return [...prev, error];
                    });
                }

                // Webpack/CRA error format
                if (data.type === 'webpackHotUpdate' && data.errors?.length) {
                    data.errors.forEach((errMsg: string) => {
                        const error: BrowserError = {
                            id: `webpack-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                            type: 'error',
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
            }
        };

        // Also handle unhandled promise rejections that might bubble up
        const handleError = (event: ErrorEvent) => {
            // Only capture if it seems to come from our iframe (localhost dev servers)
            if (event.filename?.includes('localhost')) {
                const error: BrowserError = {
                    id: `runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    type: 'error',
                    message: event.message,
                    source: event.filename,
                    lineno: event.lineno,
                    colno: event.colno,
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
        };
    }, [setErrors]);
}

export default useBrowserErrorListener;
