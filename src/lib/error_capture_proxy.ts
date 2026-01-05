/**
 * Error Capture Proxy
 * ===================
 * Injects error capture script into dev server HTML responses.
 * This allows Atlarix to capture console.error and window.onerror
 * from the iframe and display them in the Errors tab.
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import log from 'electron-log';

const logger = log.scope('error-capture-proxy');

/**
 * Error capture script to inject into HTML responses.
 * This script:
 * 1. Overrides console.error to capture error messages
 * 2. Sets up window.onerror handler for uncaught errors
 * 3. Sets up unhandledrejection handler for promise rejections
 * 4. Sends all errors to parent window via postMessage
 */
const ERROR_CAPTURE_SCRIPT = `
<script data-atlarix-error-capture>
(function() {
    console.log('[Atlarix] Error capture script loaded');
    
    // Avoid double-injection
    if (window.__atlarixErrorCapture) {
        console.log('[Atlarix] Error capture already initialized, skipping');
        return;
    }
    window.__atlarixErrorCapture = true;

    const sendError = (type, message, source, lineno, colno, stack) => {
        console.log('[Atlarix] Sending error to parent:', { type, message, source });
        try {
            window.parent.postMessage({
                type: 'atlarix-error',
                payload: {
                    type: type,
                    message: String(message),
                    source: source || window.location.href,
                    lineno: lineno,
                    colno: colno,
                    stack: stack,
                    timestamp: Date.now(),
                    url: window.location.href
                }
            }, '*');
            console.log('[Atlarix] Error sent successfully');
        } catch (e) {
            console.error('[Atlarix] Failed to send error via postMessage:', e);
        }
    };

    // Override console.error
    const originalError = console.error;
    console.error = function(...args) {
        console.log('[Atlarix] console.error intercepted:', args);
        const message = args.map(arg => {
            if (arg instanceof Error) {
                return arg.message + (arg.stack ? '\\n' + arg.stack : '');
            }
            return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
        }).join(' ');
        
        sendError('console-error', message);
        return originalError.apply(console, args);
    };

    // Global error handler
    window.onerror = function(message, source, lineno, colno, error) {
        console.log('[Atlarix] window.onerror triggered:', { message, source, lineno });
        sendError(
            'error',
            message,
            source,
            lineno,
            colno,
            error ? error.stack : null
        );
        return false; // Don't suppress the error
    };

    // Unhandled promise rejection handler
    window.addEventListener('unhandledrejection', function(event) {
        console.log('[Atlarix] unhandledrejection triggered:', event.reason);
        const reason = event.reason;
        sendError(
            'unhandled-rejection',
            reason instanceof Error ? reason.message : String(reason),
            null,
            null,
            null,
            reason instanceof Error ? reason.stack : null
        );
    });

    // Also capture module/import errors which show as SyntaxError
    window.addEventListener('error', function(event) {
        console.log('[Atlarix] error event triggered:', event);
        if (event.error || event.message) {
            sendError(
                'error',
                event.message || (event.error ? event.error.message : 'Unknown error'),
                event.filename,
                event.lineno,
                event.colno,
                event.error ? event.error.stack : null
            );
        }
    }, true);

    console.log('[Atlarix] Error capture initialized - all handlers registered');
})();
</script>
`;

interface ProxyServer {
    port: number;
    server: http.Server;
    targetUrl: string;
}

const runningProxies: Map<number, ProxyServer> = new Map();

/**
 * Create a proxy server that injects error capture script
 */
export async function createErrorCaptureProxy(
    workspaceId: number,
    targetUrl: string
): Promise<{ proxyUrl: string; port: number }> {
    // Stop existing proxy for this workspace
    stopProxy(workspaceId);

    const targetParsed = new URL(targetUrl);

    return new Promise((resolve, reject) => {
        const proxy = http.createServer((req, res) => {
            const options: http.RequestOptions = {
                hostname: targetParsed.hostname,
                port: targetParsed.port,
                path: req.url,
                method: req.method,
                headers: {
                    ...req.headers,
                    host: `${targetParsed.hostname}:${targetParsed.port}`,
                },
            };

            const proxyReq = http.request(options, (proxyRes) => {
                const contentType = proxyRes.headers['content-type'] || '';

                // If HTML response, inject our script
                if (contentType.includes('text/html')) {
                    let body = '';

                    proxyRes.on('data', (chunk) => {
                        body += chunk.toString();
                    });

                    proxyRes.on('end', () => {
                        // Inject script right after <head> tag
                        let modifiedBody = body;
                        if (body.includes('<head>')) {
                            modifiedBody = body.replace('<head>', '<head>' + ERROR_CAPTURE_SCRIPT);
                        } else if (body.includes('<HEAD>')) {
                            modifiedBody = body.replace('<HEAD>', '<HEAD>' + ERROR_CAPTURE_SCRIPT);
                        } else if (body.includes('<!DOCTYPE') || body.includes('<html')) {
                            // Inject at the start if no head tag
                            modifiedBody = ERROR_CAPTURE_SCRIPT + body;
                        }

                        // Update content-length
                        const headers = { ...proxyRes.headers };
                        delete headers['content-length'];
                        headers['content-length'] = Buffer.byteLength(modifiedBody).toString();

                        res.writeHead(proxyRes.statusCode || 200, headers);
                        res.end(modifiedBody);
                    });
                } else {
                    // Pass through non-HTML responses
                    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
                    proxyRes.pipe(res);
                }
            });

            proxyReq.on('error', (err) => {
                logger.error('Proxy request error:', err);
                res.writeHead(502);
                res.end('Proxy error: ' + err.message);
            });

            req.pipe(proxyReq);
        });

        // Find available port starting from 9100
        let proxyPort = 9100 + workspaceId;

        const tryListen = () => {
            proxy.once('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    proxyPort++;
                    tryListen();
                } else {
                    reject(err);
                }
            });

            proxy.listen(proxyPort, '127.0.0.1', () => {
                const proxyUrl = `http://localhost:${proxyPort}`;
                logger.log(`[Proxy] Started error capture proxy at ${proxyUrl} → ${targetUrl}`);

                runningProxies.set(workspaceId, {
                    port: proxyPort,
                    server: proxy,
                    targetUrl,
                });

                resolve({ proxyUrl, port: proxyPort });
            });
        };

        tryListen();
    });
}

/**
 * Stop proxy for a workspace
 */
export function stopProxy(workspaceId: number): void {
    const proxy = runningProxies.get(workspaceId);
    if (proxy) {
        logger.log(`[Proxy] Stopping error capture proxy for workspace ${workspaceId}`);
        proxy.server.close();
        runningProxies.delete(workspaceId);
    }
}

/**
 * Stop all proxies
 */
export function stopAllProxies(): void {
    runningProxies.forEach((proxy, workspaceId) => {
        stopProxy(workspaceId);
    });
}

/**
 * Get proxy URL for a workspace (if exists)
 */
export function getProxyUrl(workspaceId: number): string | null {
    const proxy = runningProxies.get(workspaceId);
    return proxy ? `http://localhost:${proxy.port}` : null;
}
